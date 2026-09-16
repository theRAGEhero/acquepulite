import express from "express";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parameters } from "./data.js";
import { loadArpaLombardia, summarizeStationMeasurements, PARAM_MAP } from "./arpaLombardia.js";
import { measurementsAreCurrent, latestSampleDate } from "./measurementFreshness.js";
import { loadArpatToscana } from "./arpatToscana.js";
import { loadArpaeEmiliaRomagna } from "./arpaeEmiliaRomagna.js";
import { loadArpaPiemonte } from "./arpaPiemonte.js";
import { loadArpaVeneto } from "./arpaVeneto.js";
import { loadArpaFvg } from "./arpaFvg.js";
import { loadArpaLazio } from "./arpaLazio.js";
import {
  queryNearbyFacilities, queryFacilitiesAlongRiver, distanceToRiverMeters, CATEGORY_LABELS
} from "./overpass.js";
import { fetchRiverGeometries } from "./riverGeometry.js";
import {
  geometryLines,
  loadOfficialHydrography,
  resolveOfficialGeometry,
  simplifyGeometry,
  snapPointToGeometry,
  sliceLineBetweenSnaps
} from "./hydrography.js";
import { ARPA_REGIONS, MAJOR_ITALIAN_RIVERS, EEA_IED } from "./arpaRegistry.js";
import {
  GISCO_REGIONS_URL, ITALIAN_REGIONS, loadWiseNationalRivers, WISE_LICENSE_URL, WISE_STATUS_URL
} from "./wiseNational.js";
import { loadEeaData, hasEeaData, POLLUTANT_MAP } from "./eeaData.js";
import { getLogStatus, getRecentLogs, log, serializeError } from "./logger.js";
import { getNearbyPopulationContext, getRiverKnowledge, getRiverImage } from "./wikimedia.js";
import {
  filterDocuments, getDocument, resolveDocumentFile, documentFacets,
  logDocumentArchiveState, DOCUMENT_TYPES
} from "./riverDocuments.js";

const app = express();
app.disable("x-powered-by");
app.use(cors({ exposedHeaders: ["X-Request-ID"] }));
app.use(express.json({ limit: "128kb" }));

const PORT = 4000;
const PARAM_ITER = Object.values(PARAM_MAP);
const riverFacilityCache = new Map();
const RIVER_FACILITY_CACHE_MS = 30 * 60 * 1000;
const runtime = {
  phase: "starting",
  boot_started_at: new Date().toISOString(),
  boot_finished_at: null,
  source_failures: []
};
const clientErrorRate = new Map();

function markSourceFailure(source, error) {
  runtime.source_failures.push({ source, message: error?.message || String(error) });
}

function acceptClientError(ip) {
  const key = String(ip || "unknown");
  const now = Date.now();
  if (clientErrorRate.size > 1000) {
    for (const [entryKey, entry] of clientErrorRate) {
      if (now - entry.startedAt > 60_000) clientErrorRate.delete(entryKey);
    }
  }
  const current = clientErrorRate.get(key);
  if (!current || now - current.startedAt > 60_000) {
    clientErrorRate.set(key, { startedAt: now, count: 1 });
    return true;
  }
  current.count += 1;
  return current.count <= 30;
}

// --- Request logger middleware ---
app.use((req, res, next) => {
  const incomingId = String(req.get("x-request-id") || "");
  req.requestId = /^[A-Za-z0-9._-]{8,80}$/.test(incomingId) ? incomingId : randomUUID();
  res.setHeader("X-Request-ID", req.requestId);
  const startedAt = process.hrtime.bigint();
  let recorded = false;
  const record = event => {
    if (recorded) return;
    recorded = true;
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const meta = {
      request_id: req.requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration_ms: Number(durationMs.toFixed(1)),
      response_bytes: Number(res.getHeader("content-length")) || null,
      event
    };
    const message = `${req.method} ${req.path} ${res.statusCode}`;
    if (res.statusCode >= 500) log.error("HTTP", message, meta);
    else if (res.statusCode >= 400) log.warn("HTTP", message, meta);
    else log.info("HTTP", message, meta);
  };
  res.once("finish", () => record("finish"));
  res.once("close", () => record("connection_closed"));
  next();
});

const asyncRoute = handler => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};

// In-memory store: only REAL data (no mock fallback).
let store = {
  rivers: [],                       // only rivers with real agency data
  stations: [],
  arpaMeasurements: new Map(),      // Lombardia measurements
  arpatStretches: new Map(),        // Regional water-body status assessments
  eea: null,                        // EEA industrial emissions dataset
  hydrography: null,                // versioned official line catalog
  nationalBaseline: null,           // EEA WISE coverage for regions without a dedicated adapter
  arpaFetchedAt: null
};

// Boot sequence: loads REAL data from regional authorities only.
// No mock/sample data anywhere. Rivers without real agency data are not shown.
async function initArpa() {
  const allRivers = [];
  const allStations = [];
  const arpaMeasurements = new Map();
  const arpatStretches = new Map();

  // --- ARPA Lombardia (Socrata API, real measurements) ---
  try {
    log.info("ARPA", "Fetching real data from dati.lombardia.it…");
    const data = await loadArpaLombardia([
      "LAMBRO", "OLONA-LAMBRO MERIDIONALE", "Po", "ADDA SUBLACUALE", "ADDA PRELACUALE",
      "BREMBO", "SERIO", "MELLA", "MERA", "MINCIO", "TICINO SUBLACUALE",
      "OGLIO SUBLACUALE", "OGLIO SOPRALACUALE", "SEVESO", "AGOGNA", "CHIESE SUBLACUALE",
      "FISSERO-TARTARO", "SPOL"
    ]);
    allRivers.push(...data.rivers);
    allStations.push(...data.stations);
    for (const [sid, m] of data.measurementsByStation) arpaMeasurements.set(sid, m);
    log.info("ARPA", `Lombardia: ${data.rivers.length} rivers, ${data.stations.length} stations`);
  } catch (e) {
    markSourceFailure("ARPA Lombardia", e);
    log.error("ARPA", `Lombardia failed: ${e.message}`);
  }

  // --- 2. ARPAT Toscana (CKAN CSV, real ecological/chemical status) ---
  try {
    const toscana = await loadArpatToscana();
    for (const r of toscana) {
      arpatStretches.set(r.id, r);
      allRivers.push(r);
    }
    log.info("ARPAT", `Toscana: ${toscana.reduce((sum, river) => sum + river.stretches.length, 0)} water bodies loaded`);
  } catch (e) {
    markSourceFailure("ARPAT Toscana", e);
    log.error("ARPAT", `Toscana failed: ${e.message}`);
  }

  // --- 3. ARPAE Emilia-Romagna (dati.arpae.it, real measurements) ---
  try {
    const emr = await loadArpaeEmiliaRomagna();
    allRivers.push(...emr.rivers);
    allStations.push(...emr.stations);
    for (const [sid, m] of emr.measurementsByStation) arpaMeasurements.set(sid, m);
    log.info("ARPAE", `Emilia-Romagna: ${emr.rivers.length} rivers, ${emr.stations.length} stations`);
  } catch (e) {
    markSourceFailure("ARPAE Emilia-Romagna", e);
    log.error("ARPAE", `Emilia-Romagna failed: ${e.message}`);
  }

  // --- 4. ARPA Piemonte (official ArcGIS WFD classification) ---
  try {
    const piemonte = await loadArpaPiemonte();
    for (const river of piemonte) {
      arpatStretches.set(river.id, river);
      allRivers.push(river);
    }
    log.info("ARPA-PIEMONTE", `Piemonte: ${piemonte.length} rivers`);
  } catch (e) {
    markSourceFailure("ARPA Piemonte", e);
    log.error("ARPA-PIEMONTE", `Piemonte failed: ${e.message}`);
  }

  // --- 5. ARPA Veneto (official LIMeco open-data CSV) ---
  try {
    const veneto = await loadArpaVeneto();
    for (const river of veneto) {
      arpatStretches.set(river.id, river);
      allRivers.push(river);
    }
    log.info("ARPA-VENETO", `Veneto: ${veneto.length} rivers`);
  } catch (e) {
    markSourceFailure("ARPA Veneto", e);
    log.error("ARPA-VENETO", `Veneto failed: ${e.message}`);
  }

  // --- 6. ARPA FVG (official WFD classification tables) ---
  try {
    const fvg = await loadArpaFvg();
    for (const river of fvg) {
      arpatStretches.set(river.id, river);
      allRivers.push(river);
    }
    log.info("ARPA-FVG", `Friuli-Venezia Giulia: ${fvg.length} rivers, ${fvg.reduce((sum, river) => sum + river.stretches.length, 0)} classified water bodies`);
  } catch (e) {
    markSourceFailure("ARPA FVG", e);
    log.error("ARPA-FVG", `Friuli-Venezia Giulia failed: ${e.message}`);
  }

  // --- 7. ARPA Lazio (official CKAN CSV, 2021-2023 WFD assessment) ---
  try {
    const lazio = await loadArpaLazio();
    for (const river of lazio) {
      arpatStretches.set(river.id, river);
      allRivers.push(river);
    }
    log.info("ARPA-LAZIO", `Lazio: ${lazio.length} rivers, ${lazio.reduce((sum, river) => sum + river.stretches.length, 0)} classified water bodies`);
  } catch (e) {
    markSourceFailure("ARPA Lazio", e);
    log.error("ARPA-LAZIO", `Lazio failed: ${e.message}`);
  }

  // Dedicated adapters know their administrative source even when the
  // original agency label contains extra text such as “(ARPAT)”. Keep a
  // stable code alongside that human-readable attribution for filtering.
  for (const river of allRivers) {
    const region = ARPA_REGIONS.find(item => String(river.region || "")
      .toLocaleLowerCase("it").includes(item.name.toLocaleLowerCase("it")));
    if (!region) continue;
    river.region_code = region.code;
    river.region_codes = [region.code];
  }

  store = {
    rivers: allRivers,
    stations: allStations,
    arpaMeasurements,
    arpatStretches,
    eea: null,
    hydrography: null,
    nationalBaseline: null,
    arpaFetchedAt: new Date().toISOString()
  };
  log.info("BOOT", `Store ready: ${allRivers.length} rivers (all real agency data), ${allStations.length} stations`);

  // --- Load EEA industrial emissions dataset (if downloaded) ---
  try {
    if (hasEeaData() || fs.existsSync(path.join(import.meta.dirname, "data", "eea"))) {
      store.eea = await loadEeaData();
      const itSites = (store.eea.sites || []).filter(s => s.country === "IT" || s.country === "ITA" || s.country === "Italy" || s.country === "IT ").length;
      log.info("EEA", `Loaded: ${store.eea.sites.length} sites total, ~${itSites} Italy, ${store.eea.pollutant.length} releases`);
      buildEeaGrid();
    } else {
      log.info("EEA", "No EEA dataset found — download from industry.eea.europa.eu and unzip into backend/data/eea/");
    }
  } catch (e) {
    markSourceFailure("EEA Industrial Emissions", e);
    log.error("EEA", `Failed to load EEA data: ${e.message}`);
  }

  // --- Fetch real river geometries from OSM ---
  await initRiverGeometries();
}

function toscanaStretches() {
  let n = 0;
  for (const [, r] of store.arpatStretches) n += r.stretches.length;
  return n;
}

// Normalise agency river names (e.g. ARPAE "T. BARDONEZZA", "F. PO")
// to a plain OSM-searchable name ("Bardonezza", "Po").
function normalizeOsmName(name) {
  let n = String(name).trim().toLowerCase();
  // strip prefixes: T. (torrente), R. (rio), F. (fiume), C. (canale)
  n = n.replace(/^(t\.|r\.|f\.|c\.|torrente|fiume|riale|canale)\s+/i, "");
  n = n.replace(/["']/g, "");
  // title case
  return n.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

async function initRiverGeometries() {
  try {
    store.hydrography = loadOfficialHydrography();
    try {
      const integratedRegionCodes = new Set(ARPA_REGIONS
        .filter(region => region.status === "integrated")
        .map(region => region.code));
      store.nationalBaseline = loadWiseNationalRivers(store.hydrography, integratedRegionCodes);
      for (const river of store.nationalBaseline.rivers) {
        store.rivers.push(river);
        store.arpatStretches.set(river.id, river);
      }
    } catch (error) {
      markSourceFailure("EEA WISE national baseline", error);
      log.error("WISE-NATIONAL", `National coverage failed: ${error.message}`);
    }
    // Map river names to OSM search names for better Nominatim matching.
    // Key = our river name, Value = OSM search term.
    const osmNameMap = {
      "Lambro": "Lambro",
      "Olona-lambro meridionale": "Lambro Meridionale",
      "Po": "Fiume Po",
      "Adda sublacuale": "Adda",
      "Adda prelacuale": "Adda",
      "Adda": "Adda",
      "Brembo": "Brembo",
      "Serio": "Serio",
      "Mella": "Mella",
      "Mera": "Mera",
      "Mincio": "Mincio",
      "Ticino sublacuale": "Ticino",
      "Ticino": "Ticino",
      "Oglio sublacuale": "Oglio",
      "Oglio sopralacuale": "Oglio",
      "Oglio": "Oglio",
      "Seveso": "Seveso",
      "Agogna": "Agogna",
      "Chiese sublacuale": "Chiese",
      "Chiese": "Chiese",
      "Fissero-tartaro": "Tartaro",
      "Spol": "Spöl",
      "Adige": "Adige",
      "Tevere": "Tevere",
      "Arno": "Arno",
      "Tanaro": "Tanaro",
      "Reno": "Reno",
      "Volturno": "Volturno",
      "Piave": "Piave",
      "Tagliamento": "Tagliamento",
      "Brenta": "Brenta",
      "Sesia": "Sesia",
      "Dora Riparia": "Dora Riparia",
      "Liri": "Liri",
      "Garigliano": "Garigliano",
      "Taro": "Taro",
      "Trebbia": "Trebbia",
      "Aterno": "Aterno-Pescara",
      "Ofanto": "Ofanto",
      "Basento": "Basento",
      "Simeto": "Simeto",
      "Nera": "Nera",
      "Velino": "Velino",
      "Tronto": "Tronto",
      "Metauro": "Metauro",
      "Foglia": "Foglia",
      "Marecchia": "Marecchia",
      "Conca": "Conca",
      "Uso": "Uso",
      "Isonzo": "Isonzo",
      "Ombrone": "Ombrone",
      "Serchio": "Serchio",
      "Magra": "Magra",
      "Sacco": "Sacco",
      "Aniene": "Aniene"
    };

    let official = 0;
    const riverNames = [];
    for (const river of store.rivers) {
      if (river.geometry_locked && river.geom) {
        official++;
        continue;
      }
      const resolved = resolveOfficialGeometry(store.hydrography, river);
      if (resolved?.geometry) {
        river.geom = resolved.geometry;
        Object.assign(river, resolved);
        official++;
      } else if (!river.official_only) {
        riverNames.push(osmNameMap[river.name] || normalizeOsmName(river.name));
      }
    }
    const uniqueNames = [...new Set(riverNames)];
    log.info("OSM", `Fetching real geometries for ${uniqueNames.length} unique rivers…`);
    const geoms = await fetchRiverGeometries(uniqueNames);

    let replaced = 0;
    for (const river of store.rivers) {
      if (river.geometry_quality === "official") continue;
      const osmName = osmNameMap[river.name] || normalizeOsmName(river.name);
      const resolved = geoms.get(osmName);
      if (resolved?.geometry) {
        river.geom = resolved.geometry;
        Object.assign(river, resolved);
        replaced++;
      } else {
        river.geom = null;
        river.geometry_source = null;
        river.geometry_quality = "unmatched";
      }
    }

    // Rivers without OSM geometry: derive a polyline from the real station
    // positions (ordered north→south by latitude). This is still real data
    // (station coordinates), not mock.
    // Keep unmatched monitoring records, but never invent geometry from station
    // positions. They remain represented by the neutral basemap network.
    for (const station of store.stations) {
      const river = store.rivers.find(item => item.id === station.river_id);
      if (!river?.geom) continue;
      const snap = snapPointToGeometry([station.lon, station.lat], river.geom);
      if (!snap) continue;
      station.station_snap_distance_m = Math.round(snap.distance_m);
      station.snap_status = snap.distance_m <= 250 ? "accepted" : snap.distance_m <= 1000 ? "review" : "rejected";
      station.requires_review = snap.distance_m > 250;
      station.river_position = snap;
      if (snap.distance_m <= 1000) {
        station.snapped_lon = snap.coordinate[0];
        station.snapped_lat = snap.coordinate[1];
      }
    }
    const unmatched = store.rivers.filter(river => !river.geom).length;
    log.info("HYDRO", `${official} official, ${replaced} topology-safe OSM, ${unmatched} unmatched; no synthetic lines`);
  } catch (e) {
    markSourceFailure("River geometry enrichment", e);
    log.warn("OSM", `Failed to fetch river geometries: ${e.message}`);
  }
}

app.get("/api/health", (req, res) => {
  const logging = getLogStatus();
  const ready = runtime.phase === "ready" || runtime.phase === "degraded";
  res.json({
    ok: runtime.phase !== "failed",
    ready,
    status: runtime.phase,
    request_id: req.requestId,
    uptime_seconds: Math.round(process.uptime()),
    boot_started_at: runtime.boot_started_at,
    boot_finished_at: runtime.boot_finished_at,
    data_updated_at: store.arpaFetchedAt,
    data: {
      rivers: store.rivers.length,
      rivers_with_geometry: store.rivers.filter(river => river.geom).length,
      stations: store.stations.length,
      eea_sites: store.eea?.sites?.length || 0
    },
    degraded_sources: [...new Set(runtime.source_failures.map(item => item.source))],
    logging: {
      level: logging.level,
      format: logging.format,
      file_enabled: logging.file_enabled,
      buffered_records: logging.buffered_records,
      recent_warning_or_error_count: getRecentLogs({ minimumLevel: "warn", limit: 100 }).length
    }
  });
});

app.get("/api/ready", (req, res) => {
  const ready = runtime.phase === "ready" || runtime.phase === "degraded";
  res.status(ready ? 200 : 503).json({ ready, status: runtime.phase, request_id: req.requestId });
});

app.post("/api/client-errors", (req, res) => {
  if (!acceptClientError(req.ip)) {
    return res.status(429).json({ error: "Client error rate limit exceeded", request_id: req.requestId });
  }
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const message = String(body.message || "Browser error").slice(0, 2000);
  const severity = body.severity === "warning" ? "warn" : "error";
  const meta = {
    request_id: req.requestId,
    kind: String(body.kind || "runtime").slice(0, 40),
    page: String(body.page || "").slice(0, 500),
    endpoint: String(body.endpoint || "").slice(0, 500),
    http_status: Number(body.http_status) || null,
    api_request_id: String(body.api_request_id || "").slice(0, 100) || null,
    duration_ms: Number(body.duration_ms) || null,
    online: body.online !== false,
    viewport: body.viewport && typeof body.viewport === "object" ? body.viewport : null,
    stack: String(body.stack || "").slice(0, 12000) || null,
    component_stack: String(body.component_stack || "").slice(0, 8000) || null
  };
  log[severity]("CLIENT", message, meta);
  res.status(202).json({ accepted: true, request_id: req.requestId });
});

app.get("/api/regions", (_req, res) => {
  const integratedCodes = new Set(ARPA_REGIONS.filter(region => region.status === "integrated").map(region => region.code));
  res.json(ITALIAN_REGIONS.map(region => ({
    code: region.code,
    name: region.name,
    rivers: store.rivers.filter(river => (river.region_codes || [river.region_code]).includes(region.code)).length,
    coverage: integratedCodes.has(region.code) ? "regional-agency" : "eea-wise-baseline"
  })));
});

function riverMatchesRegion(river, regionCode) {
  if (!regionCode) return true;
  return (river.region_codes || [river.region_code]).filter(Boolean).includes(regionCode);
}

function requestedRegion(req) {
  const code = String(req.query.region || "").toUpperCase();
  return ITALIAN_REGIONS.some(region => region.code === code) ? code : null;
}

app.get("/api/rivers", (req, res) => {
  const regionCode = requestedRegion(req);
  const displayTolerance = regionCode ? 0.00012 : 0.0012;
  res.json({
    type: "FeatureCollection",
    features: store.rivers.filter(river => river.geom && riverMatchesRegion(river, regionCode)).map(r => ({
      type: "Feature",
      geometry: simplifyGeometry(r.geom, displayTolerance),
      properties: {
        id: r.id, name: r.name, region: r.region,
        region_code: r.region_code || null,
        region_codes: r.region_codes || (r.region_code ? [r.region_code] : []),
        region_source_url: r.region_source_url || null,
        length_km: r.length_km, wfd_status: r.wfd_status,
        source: r.source || "ARPA",
        water_body_code: r.water_body_code || null,
        geometry_source: r.geometry_source || null,
        source_dataset_version: r.source_dataset_version || null,
        source_feature_id: r.source_feature_id || null,
        geometry_quality: r.geometry_quality || "unmatched",
        source_url: r.source_url || null,
        source_license: r.source_license || null,
        source_license_url: r.source_license_url || null,
        source_period: r.source_period || null,
        assessment_type: r.assessment_type || null,
        source_gaps: r.topology?.source_gaps ?? 0,
        artificial_connectors: r.topology?.artificial_connectors ?? 0,
        national_baseline: r.national_baseline === true,
        data_available: store.arpatStretches.has(r.id) || store.stations.some(station =>
          station.river_id === r.id && store.arpaMeasurements.has(station.id))
      }
    }))
  });
});

app.get("/api/rivers/:id", (req, res) => {
  const river = store.rivers.find(r => r.id === req.params.id);
  if (!river) return res.status(404).json({ error: "River not found" });
  const riverStations = store.stations.filter(s => s.river_id === river.id);
  res.json({ ...river, stations: riverStations });
});

app.get("/api/stations/:id/measurements", (req, res) => {
  const station = store.stations.find(s => s.id === req.params.id);
  if (!station) return res.status(404).json({ error: "Station not found" });
  const arpaMap = store.arpaMeasurements.get(station.id);
  if (!arpaMap) {
    return res.status(404).json({ error: "No real measurements for this station" });
  }
  res.json(summarizeStationMeasurements(arpaMap));
});

app.get("/api/rivers/:id/pollution-summary", (req, res) => {
  const river = store.rivers.find(r => r.id === req.params.id);
  if (!river) return res.status(404).json({ error: "River not found" });
  const riverStations = store.stations.filter(s => s.river_id === river.id);

  // --- Case 1: ARPA Lombardia river (real measurements) ---
  const arpaStations = riverStations.filter(s => store.arpaMeasurements.has(s.id));
  if (arpaStations.length > 0) {
    const byParam = {};
    for (const st of arpaStations) {
      const summary = summarizeStationMeasurements(store.arpaMeasurements.get(st.id));
      for (const p of summary) {
        if (!byParam[p.param_code]) {
          byParam[p.param_code] = {
            param_code: p.param_code, param_name: p.param_name,
            unit: p.unit, legal_limit: p.legal_limit,
            values: [], stations: []
          };
        }
        byParam[p.param_code].values.push(
          ...p.values.map(v => ({ station: st.name, value: v.value, timestamp: v.timestamp }))
        );
        byParam[p.param_code].stations.push(st.name);
      }
    }
    const summary = Object.values(byParam).map(p => {
      const vals = p.values.map(v => v.value);
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      const max = Math.max(...vals);
      // Every measured value carries the date it was sampled: an average is
      // meaningless to a reader who cannot tell whether it is from last season
      // or from ten years ago.
      const dates = p.values.map(v => v.timestamp).filter(Boolean).sort();
      return {
        param_code: p.param_code, param_name: p.param_name, unit: p.unit,
        legal_limit: p.legal_limit,
        avg: Number(avg.toFixed(3)), max: Number(max.toFixed(3)),
        first_date: dates[0] || null,
        latest_date: dates[dates.length - 1] || null,
        values: p.values, stations: p.stations
      };
    });
    const allDates = summary.flatMap(p => [p.first_date, p.latest_date]).filter(Boolean).sort();
    const latestSample = allDates[allDates.length - 1] || null;
    return res.json({
      river, stations: riverStations, parameters: summary,
      source: river.source || "ARPA Lombardia",
      source_url: river.source_url || null,
      source_license: river.source_license || null,
      source_license_url: river.source_license_url || null,
      source_period: river.source_period || null,
      assessment_type: river.assessment_type || "measured_parameters",
      measurement_latest_date: latestSample,
      measurements_are_current: measurementsAreCurrent(latestSample),
      fetched_at: store.arpaFetchedAt
    });
  }

  // --- Case 2: ARPAT Toscana river (ecological/chemical status per water body) ---
  const arpat = store.arpatStretches.get(river.id);
  if (arpat) {
    const stretches = arpat.stretches.map(s => ({
      name: s.name, water_body_code: s.water_body_code, comune: s.comune, status: s.status,
      ecological: s.ecological, chemical: s.chemical,
      indicator: s.indicator || null, indicator_year: s.indicator_year || null,
      ecological_assessment_year: s.ecological_assessment_year || null,
      chemical_assessment_year: s.chemical_assessment_year || null,
      ecological_confidence: s.ecological_confidence || null,
      chemical_confidence: s.chemical_confidence || null,
      score: s.score, source_url: s.source_url || river.source_url || null,
      meets_wfd_objective: s.indicator
        ? ["Elevato", "Buono"].includes(s.status)
        : (s.ecological == null || ["Elevato", "Buono"].includes(s.ecological))
          && (s.chemical == null || /^Buono$/i.test(s.chemical))
    }));
    return res.json({
      river: { ...river, stretches },
      stations: [],
      parameters: [],
      stretches,
      source: river.source,
      source_url: river.source_url || null,
      source_license: river.source_license || null,
      source_license_url: river.source_license_url || null,
      source_period: river.source_period || null,
      assessment_type: "water_body_status",
      assessment_method: river.assessment_type || null,
      fetched_at: store.arpaFetchedAt
    });
  }

  // No real data for this river
  res.status(404).json({ error: "No real agency data for this river" });
});

app.get("/api/parameters", (_req, res) => res.json(parameters));

app.get("/api/rivers/:id/knowledge", asyncRoute(async (req, res) => {
  const river = store.rivers.find(r => r.id === req.params.id);
  if (!river) return res.status(404).json({ error: "River not found" });
  try {
    res.json(await getRiverKnowledge(river));
  } catch (error) {
    log.warn("WIKIMEDIA", `${river.name}: ${error.message}`);
    res.status(502).json({
      available: false,
      error: "Wikimedia is temporarily unavailable",
      candidates: [], facts: [], wikipedia: null
    });
  }
}));

app.get("/api/rivers/:id/population-context", asyncRoute(async (req, res) => {
  const river = store.rivers.find(r => r.id === req.params.id);
  if (!river?.geom) return res.status(404).json({ error: "River geometry not found" });
  try {
    res.json(await getNearbyPopulationContext(river));
  } catch (error) {
    log.warn("WIKIDATA", `${river.name} population context: ${error.message}`);
    res.status(502).json({
      available: false,
      error: "Wikidata population context is temporarily unavailable",
      detail: error.message
    });
  }
}));

// --- Per-segment pollution coloring ----------------------------------------
// Creates river segments between consecutive ARPA monitoring stations.
// Each segment is colored by interpolated pollution score, with the actual
// measured values embedded in the properties for precise display.
//
// Key principles:
//  - Segments are only created between REAL stations (not every coord pair)
//  - Scores interpolate smoothly between stations (no abrupt jumps)
//  - Rivers with no real ARPA data get a single neutral segment (no fake data)
//  - Color palette is light and modern (pastel gradient)

const QUALITY_STOPS = [
  [0.00, [22, 140, 255]],
  [0.25, [32, 201, 255]],
  [0.45, [255, 212, 59]],
  [0.65, [255, 140, 26]],
  [0.85, [255, 59, 48]],
  [1.00, [185, 28, 28]]
];

function scoreToColor(score) {
  score = Math.max(0, Math.min(1, score));
  for (let i = 0; i < QUALITY_STOPS.length - 1; i++) {
    const [s0, c0] = QUALITY_STOPS[i];
    const [s1, c1] = QUALITY_STOPS[i + 1];
    if (score >= s0 && score <= s1) {
      const t = (score - s0) / (s1 - s0 || 1);
      const r = Math.round(c0[0] + (c1[0] - c0[0]) * t);
      const g = Math.round(c0[1] + (c1[1] - c0[1]) * t);
      const b = Math.round(c0[2] + (c1[2] - c0[2]) * t);
      return `rgb(${r},${g},${b})`;
    }
  }
  const last = QUALITY_STOPS[QUALITY_STOPS.length - 1][1];
  return `rgb(${last[0]},${last[1]},${last[2]})`;
}

// Compute a pollution score 0..1 for a station from real ARPA data.
// Only uses parameters that have a legal_limit. Returns null if no real data.
//
// Stale measurements deliberately score null. The ARPA Lombardia series this
// reads stops in December 2016, and painting a decade-old sample as current
// pollution is the kind of claim the map cannot defend. The values stay
// available in the river panel, dated, as historical record.
function realStationScore(stationId, paramFilter) {
  const arpaMap = store.arpaMeasurements.get(stationId);
  if (!arpaMap) return null;
  if (!measurementsAreCurrent(latestSampleDate(arpaMap))) return null;
  let sum = 0, n = 0;
  for (const [paramCode, arr] of arpaMap) {
    if (paramFilter && paramCode !== paramFilter) continue;
    if (!arr.length) continue;
    const latest = arr[arr.length - 1];
    const cfg = PARAM_ITER.find(p => p.code === paramCode);
    if (!cfg || !cfg.legal_limit) continue;
    sum += Math.min(2, latest.value / cfg.legal_limit);
    n++;
  }
  if (n === 0) return null;
  return Math.min(1, sum / n);
}

// Get the latest measured values for a station (for precise display)
function realStationMeasurements(stationId, paramFilter) {
  const arpaMap = store.arpaMeasurements.get(stationId);
  if (!arpaMap) return null;
  const out = [];
  for (const [paramCode, arr] of arpaMap) {
    if (paramFilter && paramCode !== paramFilter) continue;
    if (!arr.length) continue;
    const latest = arr[arr.length - 1];
    const cfg = PARAM_ITER.find(p => p.code === paramCode);
    if (!cfg) continue;
    out.push({
      param_code: paramCode,
      param_name: cfg.name,
      unit: cfg.unit,
      legal_limit: cfg.legal_limit,
      value: latest.value,
      timestamp: latest.timestamp,
      ratio: cfg.legal_limit ? Math.min(2, latest.value / cfg.legal_limit) : null
    });
  }
  return out;
}

function buildAccurateSegments(paramFilter, regionCode = null) {
  const features = [];
  for (const river of store.rivers) {
    if (!river.geom || !riverMatchesRegion(river, regionCode)) continue;
    const arpat = store.arpatStretches.get(river.id);
    if (arpat) {
      // WFD status is painted only on the matching official water-body line.
      // If official geometry has not been imported, the status stays in the
      // panel and no spatial extent is fabricated.
      for (const stretch of arpat.stretches) {
        if (!stretch.geometry) continue;
        features.push({
          type: "Feature",
          geometry: simplifyGeometry(stretch.geometry, regionCode ? 0.00012 : 0.0012),
          properties: {
            river_id: river.id,
            river_name: river.name,
            water_body: stretch.name,
            water_body_code: stretch.water_body_code,
            pollution_score: stretch.score,
            color: stretch.score != null ? scoreToColor(stretch.score) : "rgb(140,165,190)",
            status: stretch.status,
            ecological: stretch.ecological,
            chemical: stretch.chemical,
            has_real_data: true,
            source: river.source,
            source_url: stretch.source_url || river.source_url || null,
            source_license: river.source_license || null,
            source_license_url: river.source_license_url || null,
            source_period: river.source_period || null,
            assessment_type: river.assessment_type || null,
            region: river.region,
            region_code: river.region_code || null,
            region_codes: river.region_codes || [],
            region_source_url: river.region_source_url || null,
            national_baseline: river.national_baseline === true,
            geometry_source: stretch.geometry_source,
            source_feature_id: stretch.source_feature_id,
            geometry_quality: "official",
            geometry_match: stretch.geometry_match,
            requires_review: stretch.requires_review
          }
        });
      }
      continue;
    }

    const byLine = new Map();
    for (const station of store.stations.filter(item => item.river_id === river.id)) {
      if (!station.river_position || station.snap_status === "rejected") continue;
      const score = realStationScore(station.id, paramFilter);
      if (score == null) continue;
      const item = {
        ...station,
        score,
        measurements: realStationMeasurements(station.id, paramFilter),
        ...station.river_position
      };
      if (!byLine.has(item.line_index)) byLine.set(item.line_index, []);
      byLine.get(item.line_index).push(item);
    }

    const lines = geometryLines(river.geom);
    for (const [lineIndex, stations] of byLine) {
      stations.sort((a, b) => a.distance_along_m - b.distance_along_m);
      for (let i = 0; i < stations.length - 1; i++) {
        const from = stations[i];
        const to = stations[i + 1];
        const coordinates = sliceLineBetweenSnaps(lines[lineIndex], from, to);
        if (coordinates.length < 2) continue;
        const score = (from.score + to.score) / 2;
        features.push({
          type: "Feature",
          geometry: { type: "LineString", coordinates },
          properties: {
            river_id: river.id,
            river_name: river.name,
            segment_index: i,
            pollution_score: Number(score.toFixed(3)),
            color: scoreToColor(score),
            from_station: from.name,
            to_station: to.name,
            from_score: Number(from.score.toFixed(3)),
            to_score: Number(to.score.toFixed(3)),
            from_snap_m: from.station_snap_distance_m,
            to_snap_m: to.station_snap_distance_m,
            has_real_data: true,
            source: river.source || "ARPA",
            source_url: river.source_url || null,
            source_license: river.source_license || null,
            source_license_url: river.source_license_url || null,
            source_period: river.source_period || null,
            assessment_type: river.assessment_type || null,
            region: river.region,
            geometry_source: river.geometry_source,
            source_dataset_version: river.source_dataset_version,
            source_feature_id: river.source_feature_id,
            geometry_quality: river.geometry_quality,
            measurements: from.measurements
          }
        });
      }
    }
  }
  log.debug("SEGMENTS", `Built ${features.length} topology-safe monitored reaches`);
  return { type: "FeatureCollection", features };
}

app.get("/api/rivers-segments", (req, res) => {
  const param = req.query.param || null;
  res.json(buildAccurateSegments(param, requestedRegion(req)));
});

// --- Stations as GeoJSON ----------------------------------------------------
app.get("/api/stations", (req, res) => {
  const riverId = req.query.river_id;
  let stns = store.stations;
  if (riverId) stns = stns.filter(s => s.river_id === riverId);
  res.json({
    type: "FeatureCollection",
    features: stns.map(s => ({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [s.snapped_lon ?? s.lon, s.snapped_lat ?? s.lat]
      },
      properties: {
        id: s.id, river_id: s.river_id, name: s.name,
        has_real_data: store.arpaMeasurements.has(s.id),
        original_lon: s.lon,
        original_lat: s.lat,
        station_snap_distance_m: s.station_snap_distance_m ?? null,
        snap_status: s.snap_status || "unmatched",
        requires_review: s.requires_review ?? true
      }
    }))
  });
});

// --- Nearby facilities endpoint ---
app.get("/api/stations/:id/nearby-facilities", asyncRoute(async (req, res) => {
  const station = store.stations.find(s => s.id === req.params.id);
  if (!station) return res.status(404).json({ error: "Station not found" });
  const radius = Math.min(10000, Math.max(500, Number(req.query.radius) || 3000));
  try {
    const facilities = await queryNearbyFacilities(station.lat, station.lon, radius);
    res.json({
      station: { id: station.id, name: station.name, lat: station.lat, lon: station.lon },
      radius_m: radius,
      count: facilities.length,
      facilities,
      source: "OpenStreetMap (Overpass API)",
      source_url: "https://wiki.openstreetmap.org/wiki/Overpass_API",
      license_url: "https://www.openstreetmap.org/copyright",
      fetched_at: new Date().toISOString()
    });
  } catch (e) {
    log.warn("OVERPASS", `Station facility enrichment unavailable for ${station.id}`, { error: e.message });
    // Overpass is optional enrichment. Return a usable empty result instead of
    // turning a public mirror outage into an application-level 5xx response.
    res.json({
      station: { id: station.id, name: station.name, lat: station.lat, lon: station.lon },
      radius_m: radius, count: 0, facilities: [],
      source: "OpenStreetMap (Overpass API)",
      source_url: "https://wiki.openstreetmap.org/wiki/Overpass_API",
      license_url: "https://www.openstreetmap.org/copyright",
      osm_status: "unavailable",
      warning: "OpenStreetMap enrichment is temporarily unavailable. EEA registry results are shown separately.",
      retry_after_seconds: 30,
      fetched_at: new Date().toISOString()
    });
  }
}));

app.get("/api/rivers/:id/nearby-facilities", asyncRoute(async (req, res) => {
  const river = store.rivers.find(item => item.id === req.params.id);
  if (!river?.geom) return res.status(404).json({ error: "River geometry not found" });
  const radius = Math.min(5000, Math.max(500, Number(req.query.radius) || 3000));
  const sourceMode = req.query.source === "eea" ? "eea" : "all";
  const startedAt = Date.now();
  const cacheKey = `${river.id}:${radius}:${sourceMode}`;
  const cached = riverFacilityCache.get(cacheKey);
  const forceRefresh = req.query.refresh === "1";
  if (!forceRefresh && cached && Date.now() - cached.savedAt < (cached.ttlMs || RIVER_FACILITY_CACHE_MS)) return res.json(cached.value);

  let osmFacilities = [];
  let osmError = null;
  let osmQueryMeta = null;
  let osmSkippedReason = null;
  let osmCacheFallback = false;

  let indexedEea = { sites: [], candidateCount: 0 };
  let eeaFacilities = [];
  let eeaError = null;
  try {
    indexedEea = eeaSitesNearRiver(river.geom, radius);
    eeaFacilities = indexedEea.sites.filter(site => {
      if (site?.lat == null || site?.lon == null || !(site.country || "").toUpperCase().startsWith("IT")) return false;
      return distanceToRiverMeters(site.lat, site.lon, river.geom) <= radius;
    }).map(site => {
      const releases = eeaReleasesBySite.get(String(site.id)) || [];
      const reportedPollutants = Array.isArray(site.pollutants)
        ? site.pollutants
        : String(site.pollutants || "").split(/[;,|]/).map(value => value.trim()).filter(Boolean);
      return {
        id: `eea/${site.id}`, name: site.name || "Unnamed EEA industrial site",
        category: "industrial", category_label: site.sector || "EEA regulated industrial site",
        lat: site.lat, lon: site.lon,
        distance_to_river_m: distanceToRiverMeters(site.lat, site.lon, river.geom),
        source: "EEA Industrial Emissions Portal", address: site.address || "", city: site.city || "",
        release_count: releases.length || (site.has_release_data ? 1 : 0),
        has_reported_releases: releases.length > 0 || !!site.has_release_data,
        pollutants: [...new Set([
          ...releases.map(item => item.pollutant), ...reportedPollutants
        ].filter(Boolean))].slice(0, 8),
        detail_url: `/api/eea/sites/${encodeURIComponent(site.id)}`,
        external_url: EEA_IED.dataset_page
      };
    });
  } catch (error) {
    eeaError = error.message;
    log.warn("EEA", `River corridor lookup failed for ${river.name}: ${error.message}`);
  }

  if (sourceMode === "all") {
    if (eeaFacilities.length >= 100) {
      osmSkippedReason = "Local EEA registry already provides high corridor coverage";
    } else {
      try {
        const osmResult = await queryFacilitiesAlongRiver(river.geom, radius);
        osmFacilities = osmResult.facilities;
        osmQueryMeta = osmResult.meta;
      } catch (error) {
        osmError = error.message;
        osmQueryMeta = {
          query_chunks: null, successful_chunks: 0, failed_chunks: null,
          partial: false, failures: (error.failures || []).slice(0, 8)
        };
        const previousOsm = (cached?.value?.facilities || [])
          .filter(facility => facility.source === "OpenStreetMap");
        if (previousOsm.length) {
          osmFacilities = previousOsm;
          osmCacheFallback = true;
          osmQueryMeta.cached_chunks = cached.value.osm_query_chunks || 1;
          osmQueryMeta.oldest_cache_age_ms = Date.now() - cached.savedAt;
          log.warn("OVERPASS", `Using cached corridor facilities for ${river.name}`, {
            facilities: previousOsm.length,
            cache_age_ms: osmQueryMeta.oldest_cache_age_ms
          });
        }
        log.warn("OVERPASS", `River corridor query failed for ${river.name}: ${error.message}`, {
          failures: osmQueryMeta.failures
        });
      }
    }
  }

  const facilities = [];
  for (const facility of [...eeaFacilities, ...osmFacilities]) {
    const normalizedName = String(facility.name || "").toLowerCase().replace(/[^a-z0-9]+/g, "").trim();
    const duplicate = normalizedName && !normalizedName.startsWith("unnamed") && facilities.some(existing => {
      const existingName = String(existing.name || "").toLowerCase().replace(/[^a-z0-9]+/g, "").trim();
      return existingName === normalizedName && dist(existing.lat, existing.lon, facility.lat, facility.lon) <= 0.5;
    });
    if (duplicate) continue;
    facilities.push(facility);
  }
  facilities.sort((a, b) => a.distance_to_river_m - b.distance_to_river_m);
  const finalOsmCount = facilities.filter(facility => facility.source === "OpenStreetMap").length;
  const finalEeaCount = facilities.filter(facility => facility.source === "EEA Industrial Emissions Portal").length;

  const geojson = {
    type: "FeatureCollection",
    features: facilities.map(facility => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [facility.lon, facility.lat] },
      properties: {
        id: facility.id, name: facility.name, category: facility.category,
        category_label: facility.category_label, source: facility.source,
        distance_to_river_m: facility.distance_to_river_m,
        address: facility.address || facility.osm_tags?.["addr:full"] || facility.osm_tags?.["addr:street"] || "",
        operator: facility.osm_tags?.operator || "",
        website: facility.osm_tags?.website || facility.osm_tags?.["contact:website"] || "",
        release_count: facility.release_count || 0,
        pollutants: (facility.pollutants || []).join(", "),
        external_url: facility.osm_url || facility.external_url || ""
      }
    }))
  };

  const value = {
    river: { id: river.id, name: river.name }, radius_m: radius,
    count: facilities.length, osm_count: finalOsmCount, eea_count: finalEeaCount,
    osm_records_matched: osmFacilities.length, eea_records_matched: eeaFacilities.length,
    source_mode: sourceMode,
    osm_status: sourceMode === "eea" ? "not_requested" : osmSkippedReason ? "deferred" : osmCacheFallback ? "cached" : osmError ? "unavailable" : osmQueryMeta?.partial ? "partial" : osmQueryMeta?.cached_chunks ? "cached" : "complete",
    osm_skip_reason: osmSkippedReason,
    osm_query_chunks: osmQueryMeta?.query_chunks ?? null,
    osm_successful_chunks: osmQueryMeta?.successful_chunks ?? null,
    osm_failed_chunks: osmQueryMeta?.failed_chunks ?? null,
    osm_cached_chunks: osmQueryMeta?.cached_chunks ?? 0,
    osm_cache_age_ms: osmQueryMeta?.oldest_cache_age_ms ?? null,
    eea_status: eeaError ? "unavailable" : "complete",
    eea_candidates_scanned: indexedEea.candidateCount,
    query_duration_ms: Date.now() - startedAt,
    facilities, geojson,
    sources: [
      { name: "OpenStreetMap", url: "https://www.openstreetmap.org/copyright", license: "ODbL 1.0" },
      { name: "EEA Industrial Emissions Portal", url: EEA_IED.dataset_page, license: EEA_IED.license }
    ],
    warning: [
      osmCacheFallback ? "Live OpenStreetMap mirrors are temporarily unavailable. Showing results from the last successful OSM corridor scan." :
        osmError ? "Live OpenStreetMap enrichment is temporarily unavailable. Official EEA registry results remain available." : null,
      !osmError && osmQueryMeta?.cached_chunks ? `OpenStreetMap live mirrors were unavailable for ${osmQueryMeta.cached_chunks} corridor sections; cached OSM results are shown.` : null,
      osmQueryMeta?.partial ? `OpenStreetMap returned partial coverage (${osmQueryMeta.successful_chunks}/${osmQueryMeta.query_chunks} corridor sections).` : null,
      eeaError ? `EEA registry lookup unavailable: ${eeaError}. Showing OpenStreetMap results.` : null
    ].filter(Boolean).join(" ") || null,
    osm_error_detail: osmError,
    osm_failure_diagnostics: osmQueryMeta?.failures || [],
    osm_retry_after_seconds: osmError || osmQueryMeta?.partial ? 30 : null,
    fetched_at: new Date().toISOString()
  };
  riverFacilityCache.set(cacheKey, {
    savedAt: Date.now(), value,
    // Do not preserve a transient external outage for the full successful-result TTL.
    ttlMs: osmError || eeaError || osmQueryMeta?.partial || osmQueryMeta?.cached_chunks ? 5 * 60 * 1000 : RIVER_FACILITY_CACHE_MS
  });
  res.json(value);
}));

// --- Facilities categories (for frontend labels) ---
app.get("/api/facility-categories", (_req, res) => {
  res.json(CATEGORY_LABELS);
});

// --- EEA Industrial Emissions endpoints --------------------------------

// Summary of EEA data status
app.get("/api/eea/status", (_req, res) => {
  const eea = store.eea;
  res.json({
    available: !!eea && eea.sites.length > 0,
    sites_total: eea?.sites?.length || 0,
    sites_italy: eea ? eea.sites.filter(s => (s.country || "").toUpperCase().startsWith("IT")).length : 0,
    facilities: eea?.facilities?.length || 0,
    releases: eea?.pollutant?.length || 0,
    transfers: eea?.transfers?.length || 0,
    installations: eea?.installations?.length || 0,
    lcp: eea?.lcp?.length || 0,
    download_url: EEA_IED.dataset_page,
    note: "Download the 'Industrial reporting dataset' from the EEA portal and unzip into backend/data/eea/"
  });
});

// All Italian EEA sites as GeoJSON
app.get("/api/eea/sites", (req, res) => {
  const eea = store.eea;
  if (!eea || !eea.sites || eea.sites.length === 0) {
    return res.json({ type: "FeatureCollection", features: [], available: false });
  }
  // Optional bbox filter: ?bbox=minLon,minLat,maxLon,maxLat
  let sites = eea.sites;
  if (req.query.bbox) {
    const [minLon, minLat, maxLon, maxLat] = String(req.query.bbox).split(",").map(Number);
    if ([minLon, minLat, maxLon, maxLat].every(Number.isFinite)) {
      sites = sites.filter(s => s.lat != null && s.lon != null &&
        s.lon >= minLon && s.lon <= maxLon && s.lat >= minLat && s.lat <= maxLat);
    }
  }
  const limit = Math.min(5000, Number(req.query.limit) || 2000);
  const slice = sites.slice(0, limit);
  res.json({
    type: "FeatureCollection",
    features: slice.map(s => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [s.lon, s.lat] },
      properties: {
        id: s.id, name: s.name, sector: s.sector || "",
        subsector: s.subsector || "", city: s.city || "",
        address: s.address || "",
        pollutants: s.pollutants || null,
        water_groups: s.water_groups || null,
        has_release_data: !!s.has_release_data,
        reporting_year: s.reporting_year || null
      }
    })),
    available: true,
    count: slice.length,
    total: sites.length,
    truncated: sites.length > limit
  });
});

// EEA sites near a monitoring station (cross-reference with ARPA data)
// Spatial grid index for EEA sites (built at boot, ~92k sites)
let eeaGrid = null; // Map<"latIdx:lonIdx", [siteIndexes]>
let eeaReleasesBySite = new Map();
const GRID_STEP = 0.05; // ~5.5 km

function buildEeaGrid() {
  if (!store.eea || !store.eea.sites) return;
  eeaGrid = new Map();
  store.eea.sites.forEach((s, i) => {
    if (s.lat == null || s.lon == null) return;
    const key = `${Math.floor(s.lat / GRID_STEP)}:${Math.floor(s.lon / GRID_STEP)}`;
    if (!eeaGrid.has(key)) eeaGrid.set(key, []);
    eeaGrid.get(key).push(i);
  });
  eeaReleasesBySite = new Map();
  for (const release of store.eea.pollutant || []) {
    for (const id of [release.siteId, release.facilityId].filter(Boolean).map(String)) {
      if (!eeaReleasesBySite.has(id)) eeaReleasesBySite.set(id, []);
      eeaReleasesBySite.get(id).push(release);
    }
  }
  log.info("EEA", `Spatial grid built: ${eeaGrid.size} cells for ${store.eea.sites.length} sites`);
}

function eeaSitesNearRiver(geometry, radiusMetres) {
  const sites = store.eea?.sites || [];
  if (!sites.length) return { sites: [], candidateCount: 0 };
  if (!eeaGrid) return { sites, candidateCount: sites.length };

  const indexes = new Set();
  const addCells = (a, b = a) => {
    const middleLat = (a[1] + b[1]) / 2;
    const latPadding = radiusMetres / 110540;
    const lonPadding = radiusMetres / (111320 * Math.max(0.2, Math.cos(middleLat * Math.PI / 180)));
    const latMin = Math.floor((Math.min(a[1], b[1]) - latPadding) / GRID_STEP);
    const latMax = Math.floor((Math.max(a[1], b[1]) + latPadding) / GRID_STEP);
    const lonMin = Math.floor((Math.min(a[0], b[0]) - lonPadding) / GRID_STEP);
    const lonMax = Math.floor((Math.max(a[0], b[0]) + lonPadding) / GRID_STEP);
    for (let latIndex = latMin; latIndex <= latMax; latIndex++) {
      for (let lonIndex = lonMin; lonIndex <= lonMax; lonIndex++) {
        for (const siteIndex of eeaGrid.get(`${latIndex}:${lonIndex}`) || []) indexes.add(siteIndex);
      }
    }
  };

  for (const line of geometryLines(geometry)) {
    if (line.length === 1) addCells(line[0]);
    for (let index = 1; index < line.length; index++) addCells(line[index - 1], line[index]);
  }
  return { sites: [...indexes].map(index => sites[index]), candidateCount: indexes.size };
}

app.get("/api/stations/:id/nearby-eea-sites", (req, res) => {
  const station = store.stations.find(s => s.id === req.params.id);
  if (!station) return res.status(404).json({ error: "Station not found" });
  const eea = store.eea;
  if (!eea || !eea.sites || eea.sites.length === 0) {
    return res.json({ available: false, sites: [], message: "EEA dataset not loaded" });
  }
  const radius = Math.min(20000, Math.max(500, Number(req.query.radius) || 5000));
  const radiusKm = radius / 1000;

  // Query grid cells around the station
  const near = [];
  if (eeaGrid) {
    const latMin = Math.floor((station.lat - radiusKm / 111) / GRID_STEP);
    const latMax = Math.floor((station.lat + radiusKm / 111) / GRID_STEP);
    const lonMin = Math.floor((station.lon - radiusKm / (111 * Math.cos(station.lat * Math.PI / 180))) / GRID_STEP);
    const lonMax = Math.floor((station.lon + radiusKm / (111 * Math.cos(station.lat * Math.PI / 180))) / GRID_STEP);
    const seen = new Set();
    for (let la = latMin; la <= latMax; la++) {
      for (let lo = lonMin; lo <= lonMax; lo++) {
        const cell = eeaGrid.get(`${la}:${lo}`);
        if (!cell) continue;
        for (const idx of cell) {
          if (seen.has(idx)) continue;
          seen.add(idx);
          const s = eea.sites[idx];
          const d = dist(station.lat, station.lon, s.lat, s.lon);
          if (d <= radiusKm) {
            near.push({
              ...s,
              distance_km: Number(d.toFixed(2)),
              release_count: s.has_release_data ? 1 : 0,
              has_releases: !!s.has_release_data
            });
          }
        }
      }
    }
  } else {
    for (const s of eea.sites) {
      if (s.lat == null || s.lon == null) continue;
      const d = dist(station.lat, station.lon, s.lat, s.lon);
      if (d <= radiusKm) {
        near.push({
          ...s,
          distance_km: Number(d.toFixed(2)),
          release_count: s.has_release_data ? 1 : 0,
          has_releases: !!s.has_release_data
        });
      }
    }
  }
  near.sort((a, b) => a.distance_km - b.distance_km);
  // Deduplicate by stable site identity (dataset has one row per reporting
  // year). Prefer inspire_id, fall back to name+rounded coords.
  const seenIds = new Set();
  const deduped = [];
  for (const s of near) {
    const key = s.inspire_id || `${s.name}|${s.lat?.toFixed(4)}|${s.lon?.toFixed(4)}`;
    if (seenIds.has(key)) continue;
    seenIds.add(key);
    deduped.push(s);
  }
  res.json({ station, radius_m: radius, count: deduped.length, sites: deduped.slice(0, 30) });
});

// Site detail with all releases
app.get("/api/eea/sites/:id", (req, res) => {
  const eea = store.eea;
  if (!eea) return res.status(404).json({ error: "No EEA data" });
  const site = eea.sites.find(s => s.id === req.params.id);
  if (!site) return res.status(404).json({ error: "Site not found" });
  const releases = eea.pollutant.filter(p => p.siteId === site.id || p.facilityId === site.id);
  const transfers = eea.transfers.filter(t => t.siteId === site.id);
  const facilities = eea.facilities.filter(f => f.siteId === site.id);
  const installations = eea.installations.filter(i => i.siteId === site.id);
  const lcp = eea.lcp.filter(l => l.siteId === site.id);
  res.json({ site, releases, transfers, facilities, installations, lcp });
});

function dist(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) / 1000; // km
}

// --- ARPA regional registry: all 20 Italian regions ---
app.get("/api/arpa-regions", (_req, res) => {
  res.json({
    count: ARPA_REGIONS.length,
    integrated: ARPA_REGIONS.filter(r => r.status === "integrated").length,
    nationally_covered: ITALIAN_REGIONS.length,
    regions: ARPA_REGIONS
  });
});

// --- Data sources overview (for the "About data" panel) ---
app.get("/api/data-sources", (_req, res) => {
  const integratedRegions = ARPA_REGIONS.filter(region => region.status === "integrated");
  res.json({
    water_quality: {
      source: "Official regional environmental agencies + EEA WISE WFD",
      dataset: `${ITALIAN_REGIONS.length}/20 regions covered; ${integratedRegions.length} dedicated agency adapters`,
      license: "Dataset-specific open terms",
      source_url: "https://www.snpambiente.it/",
      license_url: null,
      coverage: ITALIAN_REGIONS.map(region => region.name).join(", "),
      other_regions: "0 regions without official WFD baseline coverage",
      regions: ARPA_REGIONS,
      national_baseline: {
        name: "EEA WISE WFD 2022",
        source_url: WISE_STATUS_URL,
        license: "EEA standard re-use policy / CC BY 4.0",
        license_url: WISE_LICENSE_URL,
        region_boundary_source: GISCO_REGIONS_URL,
        records: store.nationalBaseline?.metadata?.records || 0,
        rivers: store.nationalBaseline?.rivers?.length || 0,
        fallback_regions: ITALIAN_REGIONS.filter(region => !integratedRegions.some(item => item.code === region.code)).map(region => region.name)
      },
      sources: integratedRegions.map(region => ({
        name: region.arpa, region: region.name, dataset: region.water_quality_dataset,
        source_url: region.dataset_url || region.portal,
        download_url: region.download_url || null,
        portal_url: region.portal, license: region.license || "See source terms",
        license_url: region.license_url || null, notes: region.notes
      }))
    },
    river_geometries: {
      source: "Official regional/WFD hydrography with topology-safe OSM fallback",
      license: "Source-specific attribution; OSM ODbL 1.0",
      coverage: "National — " + MAJOR_ITALIAN_RIVERS.length + " major rivers",
      rivers_loaded: store.rivers.filter(r => r.geom).length,
      rivers_total: store.rivers.length,
      official_rivers: store.rivers.filter(r => r.geometry_quality === "official").length,
      osm_fallback_rivers: store.rivers.filter(r => r.geometry_source === "OpenStreetMap").length,
      unmatched_rivers: store.rivers.filter(r => !r.geom).length,
      artificial_connectors: 0,
      datasets: store.hydrography?.datasets || [],
      osm_url: "https://www.openstreetmap.org/copyright",
      eea_url: "https://water.discomap.eea.europa.eu/arcgis/rest/services/WISE_WFD/WFD2022_SurfaceWaterBody_WM/MapServer/16"
    },
    industrial_facilities: {
      source: "OpenStreetMap (Overpass API)",
      license: "ODbL 1.0",
      source_url: "https://wiki.openstreetmap.org/wiki/Overpass_API",
      license_url: "https://www.openstreetmap.org/copyright",
      categories: Object.keys(CATEGORY_LABELS),
      radius_default: "3000m corridor from the actual river line; station lookup also available"
    },
    eea_industrial_emissions: {
      portal: EEA_IED.portal,
      dataset_page: EEA_IED.dataset_page,
      license: EEA_IED.license,
      license_url: EEA_IED.license_url,
      notes: EEA_IED.notes
    },
    wikimedia: {
      wikidata_url: "https://www.wikidata.org/",
      wikipedia_url: "https://www.wikipedia.org/",
      wikidata_license: "CC0",
      wikipedia_license: "CC BY-SA",
      api_docs_url: "https://www.mediawiki.org/wiki/Wikibase/API",
      query_service_docs_url: "https://www.wikidata.org/wiki/Wikidata:SPARQL_query_service/queries/examples#Geographic_locations",
      population_property_url: "https://www.wikidata.org/wiki/Property:P1082",
      point_in_time_property_url: "https://www.wikidata.org/wiki/Property:P585",
      wikipedia_api_docs_url: "https://www.mediawiki.org/wiki/Wikimedia_REST_API",
      environmental_incident_class_url: "https://www.wikidata.org/wiki/Q3193890"
    },
    updated_at: store.arpaFetchedAt || new Date().toISOString()
  });
});

// --- Major Italian rivers list ---
app.get("/api/major-rivers", (_req, res) => {
  res.json(MAJOR_ITALIAN_RIVERS);
});

// --- River document archive ------------------------------------------------
// File-based archive in backend/data/documents/. The page stays accessible
// while the archive is empty; the team fills it over time.

app.get("/api/documents", (req, res) => {
  const riverId = req.query.river || null;
  const riverRecord = riverId ? store.rivers.find(item => item.id === riverId) : null;
  const { documents, errors } = filterDocuments({
    query: req.query.q || null,
    type: req.query.type || null,
    region: req.query.region || null,
    river: riverId,
    riverName: riverRecord?.name || null,
    year: req.query.year || null
  });
  res.json({
    count: documents.length,
    documents,
    facets: documentFacets(),
    types: DOCUMENT_TYPES,
    load_errors: errors,
    note: "Archive is file-based: add JSON metadata to backend/data/documents/ and files to backend/data/documents/files/."
  });
});

app.get("/api/documents/:id", (req, res) => {
  const doc = getDocument(req.params.id);
  if (!doc) return res.status(404).json({ error: "Document not found" });
  res.json({ ...doc, download_url: doc.file ? `/api/documents/${doc.id}/file` : null });
});

app.get("/api/documents/:id/file", (req, res) => {
  const doc = getDocument(req.params.id);
  if (!doc) return res.status(404).json({ error: "Document not found" });
  const filePath = resolveDocumentFile(doc);
  if (!filePath) return res.status(404).json({ error: "Document file not found in archive" });
  res.download(filePath, doc.file);
});

// Rivers index for the documents page: every river known to the system,
// including those without geometry, so documents can be attached to any river.
app.get("/api/rivers-index", (_req, res) => {
  const seen = new Set();
  const rivers = [];
  for (const river of store.rivers) {
    const key = String(river.id || "").toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    rivers.push({
      id: river.id,
      name: river.name,
      region: river.region || null,
      region_code: river.region_code || null,
      region_codes: river.region_codes || (river.region_code ? [river.region_code] : []),
      length_km: river.length_km,
      wfd_status: river.wfd_status,
      geometry_source: river.geometry_source || null,
      source_dataset_version: river.source_dataset_version || null,
      source_feature_id: river.source_feature_id || null,
      geometry_quality: river.geometry_quality || "unmatched",
      source_url: river.source_url || null,
      source_license: river.source_license || null,
      source_license_url: river.source_license_url || null,
      source_period: river.source_period || null,
      assessment_type: river.assessment_type || null,
      region_source_url: river.region_source_url || null,
      national_baseline: river.national_baseline === true,
      has_geometry: Boolean(river.geom),
      has_data: store.arpatStretches.has(river.id) || store.stations.some(station =>
        station.river_id === river.id && store.arpaMeasurements.has(station.id))
    });
  }
  rivers.sort((a, b) => a.name.localeCompare(b.name, "it"));
  res.json({ count: rivers.length, rivers });
});

// River gallery images: real Wikimedia Commons photos, cached 24h.
// The gallery stays usable while images load or when none exist yet.
app.get("/api/rivers/:id/image", asyncRoute(async (req, res) => {
  const river = store.rivers.find(item => item.id === req.params.id);
  if (!river) return res.status(404).json({ error: "River not found" });
  try {
    res.json(await getRiverImage(river));
  } catch (error) {
    log.warn("WIKIMEDIA", `${river.name} image: ${error.message}`);
    res.status(502).json({
      available: false,
      error: "Wikimedia is temporarily unavailable",
      image_url: null, thumb_url: null, page_url: null
    });
  }
}));

app.use((req, res) => {
  res.status(404).json({ error: "API route not found", request_id: req.requestId });
});

app.use((error, req, res, _next) => {
  const invalidJson = error?.type === "entity.parse.failed";
  const status = invalidJson ? 400 : Math.max(400, Math.min(599, Number(error?.status || error?.statusCode) || 500));
  const severity = status >= 500 ? "error" : "warn";
  log[severity]("API_ERROR", error?.message || "Unhandled API error", {
    request_id: req.requestId,
    method: req.method,
    path: req.path,
    status,
    error: serializeError(error, status >= 500)
  });
  if (res.headersSent) return;
  res.status(status).json({
    error: invalidJson ? "Invalid JSON payload" : status >= 500 ? "Internal server error" : error.message,
    request_id: req.requestId
  });
});

let httpServer = null;
let shuttingDown = false;

function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  runtime.phase = "stopping";
  log.info("SERVER", `Graceful shutdown requested: ${signal}`, { signal, exit_code: exitCode });
  const forceTimer = setTimeout(() => {
    log.fatal("SERVER", "Graceful shutdown timed out", { signal });
    process.exit(exitCode || 1);
  }, 10_000);
  forceTimer.unref();
  if (!httpServer) {
    clearTimeout(forceTimer);
    process.exit(exitCode);
    return;
  }
  httpServer.close(error => {
    clearTimeout(forceTimer);
    if (error) log.error("SERVER", "HTTP server close failed", { error: serializeError(error) });
    else log.info("SERVER", "HTTP server stopped cleanly");
    process.exit(error ? 1 : exitCode);
  });
}

process.on("unhandledRejection", reason => {
  runtime.phase = runtime.phase === "loading" ? "loading" : "degraded";
  log.error("PROCESS", "Unhandled promise rejection", { error: serializeError(reason) });
});
process.on("uncaughtException", error => {
  runtime.phase = "failed";
  log.fatal("PROCESS", "Uncaught exception", { error: serializeError(error) });
  shutdown("uncaughtException", 1);
});
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));

httpServer = app.listen(PORT, async () => {
  runtime.phase = "loading";
  log.info("SERVER", `Backend API on http://localhost:${PORT}`);
  log.info("SERVER", "Logging initialized", getLogStatus());
  try {
    await initArpa();
    logDocumentArchiveState();
    runtime.phase = runtime.source_failures.length ? "degraded" : "ready";
    runtime.boot_finished_at = new Date().toISOString();
    log.info("BOOT", `Initialization complete: ${runtime.phase}`, {
      duration_ms: new Date(runtime.boot_finished_at) - new Date(runtime.boot_started_at),
      degraded_sources: [...new Set(runtime.source_failures.map(item => item.source))]
    });
  } catch (error) {
    runtime.phase = "failed";
    runtime.boot_finished_at = new Date().toISOString();
    log.fatal("BOOT", "Initialization failed", { error: serializeError(error) });
  }
});

httpServer.on("error", error => {
  runtime.phase = "failed";
  log.fatal("SERVER", "HTTP server error", { error: serializeError(error) });
});
