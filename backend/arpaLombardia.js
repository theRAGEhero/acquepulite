// ARPA Lombardia adapter — fetches real data from dati.lombardia.it Socrata API
// Dataset: ixjj-e763 "Dato analitico puntuale rete monitoraggio qualitativo corsi d'acqua"
// License: CC0 1.0 (Public Domain). Attribution: ARPA Lombardia.

import { log } from "./logger.js";
import { describeMeasurementPeriod } from "./measurementFreshness.js";

const SOC_BASE = "https://www.dati.lombardia.it/resource/ixjj-e763.json";
const SOC_DATASET_ID = "ixjj-e763";

// Curated parameter mapping: ARPA name -> our schema code
const PARAM_MAP = {
  "Azoto nitrico": { code: "NO3", name: "Nitrates (as N)", unit: "mg/L", legal_limit: 10 },
  "Ortofosfato": { code: "PO4", name: "Orthophosphate", unit: "mg/L P", legal_limit: 0.2 },
  "Fosforo Totale": { code: "PTOT", name: "Total Phosphorus", unit: "mg/L P", legal_limit: 0.2 },
  "Escherichia coli": { code: "EC", name: "Escherichia coli", unit: "MPN/100mL", legal_limit: 500 },
  "Piombo": { code: "PB", name: "Lead", unit: "\u00b5g/L", legal_limit: 10 },
  "Ossigeno disciolto": { code: "DO", name: "Dissolved Oxygen", unit: "mg/L", legal_limit: null },
  "Ammoniaca totale": { code: "NH4", name: "Total Ammonia", unit: "mg/L N", legal_limit: 0.5 },
  "Nichel": { code: "NI", name: "Nickel", unit: "\u00b5g/L", legal_limit: 20 },
  "Cromo totale": { code: "CR", name: "Total Chromium", unit: "\u00b5g/L", legal_limit: 50 },
  "Cadmio": { code: "CD", name: "Cadmium", unit: "\u00b5g/L", legal_limit: 0.25 },
  "Arsenico": { code: "AS", name: "Arsenic", unit: "\u00b5g/L", legal_limit: 10 },
  "Mercurio": { code: "HG", name: "Mercury", unit: "\u00b5g/L", legal_limit: 0.05 },
  "BOD-5": { code: "BOD5", name: "BOD5", unit: "mg/L O2", legal_limit: 5 },
  "COD": { code: "COD", name: "COD", unit: "mg/L O2", legal_limit: 30 },
  "Nitrati": { code: "NO3ALT", name: "Nitrates (NO3-)", unit: "mg/L", legal_limit: 10 }
};


// The WFD status of these basins used to come from a hardcoded table here, with
// "moderate" as the default for any basin missing from it. That table cited no
// source: it asserted an official-looking classification that no agency had
// published. A river whose class is unknown is now reported as unclassified,
// and the official classification arrives from the WISE national baseline.

function measurementPeriod(byStation) {
  let first = null;
  let last = null;
  for (const byParam of byStation.values()) {
    for (const values of byParam.values()) {
      for (const { timestamp } of values) {
        if (!timestamp) continue;
        if (first === null || timestamp < first) first = timestamp;
        if (last === null || timestamp > last) last = timestamp;
      }
    }
  }
  return { first, last };
}

function toNum(v) {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Socrata ${res.status}: ${await res.text()}`);
  return res.json();
}

async function loadBasin(basin) {
  log.debug("ARPA", `Loading basin: ${basin}`);
  const where = `bacino_idrografico='${basin.replace(/'/g, "\\'")}'`;
  // 1) distinct stations
  const stationUrl =
    `${SOC_BASE}?$select=stazione,cod_stazione,geo_x,geo_y,comune,provincia,nome_corpo_idrico` +
    `&$group=stazione,cod_stazione,geo_x,geo_y,comune,provincia,nome_corpo_idrico` +
    `&$limit=200&$where=${encodeURIComponent(where)}&$order=geo_y desc`;
  const stationRows = await fetchJson(stationUrl);
  const stations = stationRows
    .filter(r => r.geo_x && r.geo_y)
    .map((r, i) => ({
      id: r.cod_stazione || `${basin}_st_${i}`,
      river_id: basin.toLowerCase().replace(/[^a-z0-9]+/g, "_"),
      name: `${r.stazione} (${r.comune || r.provincia || ""})`.trim(),
      lat: toNum(r.geo_y),
      lon: toNum(r.geo_x),
      arpa: true
    }));

  // 2) measurements for curated params
  const paramNames = Object.keys(PARAM_MAP);
  const paramList = paramNames.map(p => `'${p.replace(/'/g, "\\'")}'`).join(",");
  const measUrl =
    `${SOC_BASE}?$select=stazione,cod_stazione,parametro,valore_numerico,um,datacampionamento` +
    `&$where=${encodeURIComponent(`${where} AND parametro IN (${paramList}) AND valore_numerico IS NOT NULL`)} ` +
    `&$limit=50000&$order=datacampionamento DESC`;
  const measRows = await fetchJson(measUrl);

  // bucket: stationId -> paramCode -> [ {value, timestamp}, ... ]
  const byStation = new Map();
  for (const r of measRows) {
    const cfg = PARAM_MAP[r.parametro];
    if (!cfg) continue;
    const sid = r.cod_stazione;
    if (!sid) continue;
    const val = toNum(r.valore_numerico);
    if (val == null) continue;
    const ts = (r.datacampionamento || "").slice(0, 10);
    if (!byStation.has(sid)) byStation.set(sid, new Map());
    const m = byStation.get(sid);
    if (!m.has(cfg.code)) m.set(cfg.code, []);
    m.get(cfg.code).push({ value: val, timestamp: ts, unit: r.um || cfg.unit });
  }

  const period = measurementPeriod(byStation);
  const riverId = basin.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  const river = {
    id: riverId,
    name: basin.charAt(0) + basin.slice(1).toLowerCase(),
    region: "Lombardia (ARPA)",
    length_km: null,
    // No agency classification is published in this dataset; it carries
    // measurements only. Unclassified is the honest answer.
    wfd_status: null,
    source: "ARPA Lombardia",
    source_url: `https://www.dati.lombardia.it/d/${SOC_DATASET_ID}`,
    source_license: "CC0 1.0",
    source_license_url: "https://creativecommons.org/publicdomain/zero/1.0/",
    // Derived from the data itself, so it cannot drift away from the truth.
    source_period: describeMeasurementPeriod(period),
    measurement_first_date: period.first,
    measurement_last_date: period.last,
    assessment_type: "Measured parameters compared with configured environmental thresholds",
    // Geometry is resolved later from official WISE hydrography, falling back to
    // OpenStreetMap; server.js sets it to null when neither matches. Never
    // synthesise a course from station points — that is not a river line.
    geom: null
  };

  return { river, stations, byStation, basin };
}

export async function loadArpaLombardia(basins = ["LAMBRO"]) {
  log.info("ARPA", `Loading ${basins.length} basins: ${basins.join(", ")}`);
  const results = await Promise.all(basins.map(loadBasin));
  const rivers = [];
  const stations = [];
  const measurementsByStation = new Map();
  for (const r of results) {
    rivers.push(r.river);
    stations.push(...r.stations);
    for (const [sid, m] of r.byStation) measurementsByStation.set(sid, m);
    log.debug("ARPA", `  ${r.basin}: ${r.stations.length} stations`);
  }
  log.info("ARPA", `Total: ${rivers.length} rivers, ${stations.length} stations`);
  return { rivers, stations, measurementsByStation, source: "ARPA Lombardia", fetchedAt: new Date().toISOString() };
}

export function summarizeStationMeasurements(byParamMap) {
  const out = [];
  for (const [code, arr] of byParamMap) {
    const cfg = Object.values(PARAM_MAP).find(p => p.code === code);
    if (!cfg || arr.length === 0) continue;
    const sorted = [...arr].sort((a, b) => a.timestamp < b.timestamp ? -1 : 1);
    const vals = sorted.map(v => v.value);
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const max = Math.max(...vals);
    out.push({
      param_code: code,
      param_name: cfg.name,
      unit: cfg.unit,
      legal_limit: cfg.legal_limit,
      avg: Number(avg.toFixed(3)),
      max: Number(max.toFixed(3)),
      latest: sorted[sorted.length - 1].value,
      latest_date: sorted[sorted.length - 1].timestamp,
      values: sorted.slice(-12).map(v => ({ value: v.value, timestamp: v.timestamp }))
    });
  }
  return out;
}

export { PARAM_MAP, SOC_DATASET_ID };
