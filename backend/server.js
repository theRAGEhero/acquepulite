import express from "express";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import { parameters } from "./data.js";
import { loadArpaLombardia, summarizeStationMeasurements, PARAM_MAP } from "./arpaLombardia.js";
import { loadArpatToscana } from "./arpatToscana.js";
import { loadArpaeEmiliaRomagna } from "./arpaeEmiliaRomagna.js";
import { loadArpaPiemonte } from "./arpaPiemonte.js";
import { loadArpaVeneto } from "./arpaVeneto.js";
import {
  queryNearbyFacilities, queryFacilitiesAlongRiver, distanceToRiverMeters, CATEGORY_LABELS
} from "./overpass.js";
import { fetchRiverGeometries } from "./riverGeometry.js";
import {
  geometryLines,
  loadOfficialHydrography,
  resolveOfficialGeometry,
  snapPointToGeometry,
  sliceLineBetweenSnaps
} from "./hydrography.js";
import { ARPA_REGIONS, MAJOR_ITALIAN_RIVERS, EEA_IED } from "./arpaRegistry.js";
import { loadEeaData, hasEeaData, POLLUTANT_MAP } from "./eeaData.js";
import { log } from "./logger.js";
import { getNearbyPopulationContext, getRiverKnowledge } from "./wikimedia.js";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 4000;
const PARAM_ITER = Object.values(PARAM_MAP);
const riverFacilityCache = new Map();
const RIVER_FACILITY_CACHE_MS = 30 * 60 * 1000;

// --- Request logger middleware ---
app.use((req, _res, next) => {
  const t0 = Date.now();
  _res.on("finish", () => {
    log.info("API", `${req.method} ${req.originalUrl} ${_res.statusCode} ${Date.now() - t0}ms`);
  });
  next();
});

// In-memory store: only REAL data (no mock fallback).
let store = {
  rivers: [],                       // only rivers with real agency data
  stations: [],
  arpaMeasurements: new Map(),      // Lombardia measurements
  arpatStretches: new Map(),        // Toscana water-body statuses
  eea: null,                        // EEA industrial emissions dataset
  hydrography: null,                // versioned official line catalog
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
    log.error("ARPA-VENETO", `Veneto failed: ${e.message}`);
  }

  store = {
    rivers: allRivers,
    stations: allStations,
    arpaMeasurements,
    arpatStretches,
    eea: null,
    hydrography: null,
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
    log.warn("OSM", `Failed to fetch river geometries: ${e.message}`);
  }
}

app.get("/api/health", (_req, res) => res.json({ ok: true, arpa_fetched_at: store.arpaFetchedAt }));

app.get("/api/regions", (_req, res) => {
  const seen = new Set();
  const regions = [];
  for (const r of store.rivers) {
    for (const reg of r.region.split("/")) {
      const t = reg.trim();
      if (!seen.has(t)) { seen.add(t); regions.push({ name: t, rivers: 0 }); }
    }
  }
  for (const r of store.rivers) {
    for (const reg of r.region.split("/")) {
      const t = reg.trim();
      const x = regions.find(x => x.name === t);
      if (x) x.rivers++;
    }
  }
  res.json(regions);
});

app.get("/api/rivers", (_req, res) => {
  res.json({
    type: "FeatureCollection",
    features: store.rivers.filter(r => r.geom).map(r => ({
      type: "Feature",
      geometry: r.geom,
      properties: {
        id: r.id, name: r.name, region: r.region,
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
        data_available: store.arpaMeasurements.size > 0 || store.arpatStretches.has(r.id)
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
      return {
        param_code: p.param_code, param_name: p.param_name, unit: p.unit,
        legal_limit: p.legal_limit,
        avg: Number(avg.toFixed(3)), max: Number(max.toFixed(3)),
        values: p.values, stations: p.stations
      };
    });
    return res.json({
      river, stations: riverStations, parameters: summary,
      source: river.source || "ARPA Lombardia",
      source_url: river.source_url || null,
      source_license: river.source_license || null,
      source_license_url: river.source_license_url || null,
      source_period: river.source_period || null,
      assessment_type: river.assessment_type || "measured_parameters",
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

app.get("/api/rivers/:id/knowledge", async (req, res) => {
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
});

app.get("/api/rivers/:id/population-context", async (req, res) => {
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
});

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
function realStationScore(stationId, paramFilter) {
  const arpaMap = store.arpaMeasurements.get(stationId);
  if (!arpaMap) return null;
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

// Linear interpolation along a river's coordinates between two stations,
// producing a smooth color gradient. Splits the river geometry into
// sub-segments that transition from the upstream score to the downstream score.
function interpolateSegment(coords, fromIdx, toIdx, fromScore, toScore,
                            river, segIndex, fromStation, toStation,
                            fromMeas, toMeas) {
  const segCoords = coords.slice(fromIdx, toIdx + 1);
  if (segCoords.length < 2) return null;
  const nSubSegs = segCoords.length - 1;
  const features = [];
  for (let i = 0; i < nSubSegs; i++) {
    const t = nSubSegs > 0 ? i / nSubSegs : 0;
    const score = fromScore + (toScore - fromScore) * t;
    features.push({
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: [segCoords[i], segCoords[i + 1]]
      },
      properties: {
        river_id: river.id,
        river_name: river.name,
        segment_index: segIndex + i,
        sub_index: i,
        pollution_score: Number(score.toFixed(3)),
        color: scoreToColor(score),
        from_station: fromStation?.name || null,
        to_station: toStation?.name || null,
        from_score: fromScore != null ? Number(fromScore.toFixed(3)) : null,
        to_score: toScore != null ? Number(toScore.toFixed(3)) : null,
        is_interpolated: i < nSubSegs, // last sub-seg reaches the station
        has_real_data: true,
        source: river.source || "ARPA",
        measurements: i === 0 ? fromMeas : null // attach measurements at station point
      }
    });
  }
  return features;
}

// Decimate a coordinate array to a target max length, keeping shape.
// Rivers have thousands of OSM points; we only need ~100-200 for
// per-tract coloring to keep payload sizes manageable.
function decimate(coords, maxLen = 150) {
  if (coords.length <= maxLen) return coords;
  const step = (coords.length - 1) / (maxLen - 1);
  const out = [];
  for (let i = 0; i < maxLen; i++) {
    out.push(coords[Math.round(i * step)]);
  }
  return out;
}

function buildSegments(paramFilter) {
  const features = [];
  for (const river of store.rivers) {
    const rawCoords = river.geom?.coordinates;
    if (!rawCoords || rawCoords.length < 2) continue;
    const coords = decimate(rawCoords, 150);

    // --- ARPAT Toscana path: color by water-body status along the river ---
    const arpat = store.arpatStretches.get(river.id);
    if (arpat && arpat.stretches.length > 0) {
      const stretches = arpat.stretches;
      const nCoords = coords.length;
      // Assign each stretch a portion of the polyline (evenly split)
      for (let i = 0; i < stretches.length; i++) {
        const s = stretches[i];
        const startIdx = Math.floor(i * nCoords / stretches.length);
        const endIdx = Math.max(startIdx + 1, Math.floor((i + 1) * nCoords / stretches.length));
        // Skip tiny slices at the end
        if (startIdx >= nCoords - 1) break;
        const segCoords = coords.slice(startIdx, endIdx + 1);
        for (let j = 0; j < segCoords.length - 1; j++) {
          features.push({
            type: "Feature",
            geometry: { type: "LineString", coordinates: [segCoords[j], segCoords[j + 1]] },
            properties: {
              river_id: river.id,
              river_name: river.name,
              segment_index: i,
              sub_index: j,
              pollution_score: s.score != null ? Number(s.score.toFixed(3)) : null,
              color: s.score != null ? scoreToColor(s.score) : "rgb(140,165,190)",
              water_body: s.name,
              comune: s.comune,
              status: s.status,
              ecological: s.ecological || null,
              chemical: s.chemical || null,
              has_real_data: true,
              source: "ARPAT Toscana"
            }
          });
        }
      }
      continue;
    }

    const riverStations = store.stations
      .filter(s => s.river_id === river.id)
      .map(s => {
        const score = realStationScore(s.id, paramFilter);
        const meas = realStationMeasurements(s.id, paramFilter);
        return { ...s, score, meas };
      });

    const realStations = riverStations.filter(s => s.score != null);

    // --- No real data at all → skip this river entirely ---
    if (realStations.length === 0) {
      continue;
    }

    // --- Case 2: Real ARPA data → interpolated segments between stations ---
    // Sort stations by position along the river (north → south by lat)
    realStations.sort((a, b) => b.lat - a.lat);

    // Find the index in coords closest to each station
    const stationCoordIdx = realStations.map(st => {
      let bestIdx = 0, bestDist = Infinity;
      for (let i = 0; i < coords.length; i++) {
        const d = (coords[i][0] - st.lon) ** 2 + (coords[i][1] - st.lat) ** 2;
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      }
      return bestIdx;
    });

    let segIdx = 0;

    // Segment from river source to first station (use first station's score)
    if (stationCoordIdx[0] > 0) {
      const subCoords = coords.slice(0, stationCoordIdx[0] + 1);
      for (let i = 0; i < subCoords.length - 1; i++) {
        features.push({
          type: "Feature",
          geometry: { type: "LineString", coordinates: [subCoords[i], subCoords[i + 1]] },
          properties: {
            river_id: river.id, river_name: river.name,
            segment_index: segIdx++, sub_index: i,
            pollution_score: Number(realStations[0].score.toFixed(3)),
            color: scoreToColor(realStations[0].score),
            from_station: null, to_station: realStations[0].name,
            from_score: null, to_score: Number(realStations[0].score.toFixed(3)),
            has_real_data: true, is_upstream: true
          }
        });
      }
    }

    // Segments between consecutive stations (interpolated)
    for (let s = 0; s < realStations.length - 1; s++) {
      const fromIdx = stationCoordIdx[s];
      const toIdx = stationCoordIdx[s + 1];
      if (toIdx <= fromIdx) continue;
      const segFeats = interpolateSegment(
        coords, fromIdx, toIdx,
        realStations[s].score, realStations[s + 1].score,
        river, segIdx,
        realStations[s], realStations[s + 1],
        realStations[s].meas, realStations[s + 1].meas
      );
      if (segFeats) {
        features.push(...segFeats);
        segIdx += segFeats.length;
      }
    }

    // Segment from last station to river mouth (use last station's score)
    const lastIdx = stationCoordIdx[stationCoordIdx.length - 1];
    if (lastIdx < coords.length - 1) {
      const subCoords = coords.slice(lastIdx);
      const lastScore = realStations[realStations.length - 1].score;
      for (let i = 0; i < subCoords.length - 1; i++) {
        features.push({
          type: "Feature",
          geometry: { type: "LineString", coordinates: [subCoords[i], subCoords[i + 1]] },
          properties: {
            river_id: river.id, river_name: river.name,
            segment_index: segIdx++, sub_index: i,
            pollution_score: Number(lastScore.toFixed(3)),
            color: scoreToColor(lastScore),
            from_station: realStations[realStations.length - 1].name, to_station: null,
            from_score: Number(lastScore.toFixed(3)), to_score: null,
            has_real_data: true, is_downstream: true
          }
        });
      }
    }
  }
  log.debug("SEGMENTS", `Built ${features.length} segments (${features.filter(f => f.properties.has_real_data).length} with real data)`);
  return { type: "FeatureCollection", features };
}

function buildAccurateSegments(paramFilter) {
  const features = [];
  for (const river of store.rivers) {
    if (!river.geom) continue;
    const arpat = store.arpatStretches.get(river.id);
    if (arpat) {
      // WFD status is painted only on the matching official water-body line.
      // If official geometry has not been imported, the status stays in the
      // panel and no spatial extent is fabricated.
      for (const stretch of arpat.stretches) {
        if (!stretch.geometry) continue;
        features.push({
          type: "Feature",
          geometry: stretch.geometry,
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
  res.json(buildAccurateSegments(param));
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
app.get("/api/stations/:id/nearby-facilities", async (req, res) => {
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
    log.error("API", `nearby-facilities failed for ${station.id}`, { error: e.message });
    res.status(502).json({ error: "Failed to query nearby facilities", detail: e.message });
  }
});

app.get("/api/rivers/:id/nearby-facilities", async (req, res) => {
  const river = store.rivers.find(item => item.id === req.params.id);
  if (!river?.geom) return res.status(404).json({ error: "River geometry not found" });
  const radius = Math.min(5000, Math.max(500, Number(req.query.radius) || 3000));
  const sourceMode = req.query.source === "eea" ? "eea" : "all";
  const startedAt = Date.now();
  const cacheKey = `${river.id}:${radius}:${sourceMode}`;
  const cached = riverFacilityCache.get(cacheKey);
  if (cached && Date.now() - cached.savedAt < (cached.ttlMs || RIVER_FACILITY_CACHE_MS)) return res.json(cached.value);

  let osmFacilities = [];
  let osmError = null;
  if (sourceMode === "all") {
    try {
      osmFacilities = await queryFacilitiesAlongRiver(river.geom, radius);
    } catch (error) {
      osmError = error.message;
      log.warn("OVERPASS", `River corridor query failed for ${river.name}: ${error.message}`);
    }
  }

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
    osm_status: sourceMode === "eea" ? "not_requested" : osmError ? "unavailable" : "complete",
    eea_status: eeaError ? "unavailable" : "complete",
    eea_candidates_scanned: indexedEea.candidateCount,
    query_duration_ms: Date.now() - startedAt,
    facilities, geojson,
    sources: [
      { name: "OpenStreetMap", url: "https://www.openstreetmap.org/copyright", license: "ODbL 1.0" },
      { name: "EEA Industrial Emissions Portal", url: EEA_IED.dataset_page, license: EEA_IED.license }
    ],
    warning: [
      osmError ? `OpenStreetMap query unavailable: ${osmError}. Showing EEA registry results.` : null,
      eeaError ? `EEA registry lookup unavailable: ${eeaError}. Showing OpenStreetMap results.` : null
    ].filter(Boolean).join(" ") || null,
    fetched_at: new Date().toISOString()
  };
  riverFacilityCache.set(cacheKey, {
    savedAt: Date.now(), value,
    // Do not preserve a transient external outage for the full successful-result TTL.
    ttlMs: osmError || eeaError ? 2 * 60 * 1000 : RIVER_FACILITY_CACHE_MS
  });
  res.json(value);
});

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
    regions: ARPA_REGIONS
  });
});

// --- Data sources overview (for the "About data" panel) ---
app.get("/api/data-sources", (_req, res) => {
  res.json({
    water_quality: {
      source: "Official regional environmental agencies",
      dataset: "Five integrated regional datasets",
      license: "Dataset-specific open terms",
      source_url: "https://www.snpambiente.it/",
      license_url: null,
      coverage: "Lombardia, Toscana, Emilia-Romagna, Piemonte and Veneto",
      other_regions: ARPA_REGIONS.filter(r => r.status !== "integrated").length + " regions researched, pending integration",
      regions: ARPA_REGIONS,
      sources: ARPA_REGIONS.filter(region => region.status === "integrated").map(region => ({
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

app.listen(PORT, async () => {
  log.info("SERVER", `Backend API on http://localhost:${PORT}`);
  log.info("SERVER", `Log level: ${process.env.LOG_LEVEL || "info"}`);
  await initArpa();
});
