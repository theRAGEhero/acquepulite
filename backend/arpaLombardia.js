// ARPA Lombardia adapter — fetches real data from dati.lombardia.it Socrata API
// Dataset: ixjj-e763 "Dato analitico puntuale rete monitoraggio qualitativo corsi d'acqua"
// License: CC0 1.0 (Public Domain). Attribution: ARPA Lombardia.

import { log } from "./logger.js";

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

// Mock geometries (approximate) keyed by basin id — these are not from ARPA
// (Socrata dataset has station points, not river LineStrings).
// When a basin is not in this map, a polyline is derived from station points.
const BASIN_GEOMETRIES = {
  LAMBRO: [
    [9.27, 45.88], [9.26, 45.82], [9.24, 45.77], [9.24, 45.72],
    [9.29, 45.65], [9.27, 45.58], [9.27, 45.51], [9.25, 45.44],
    [9.27, 45.37], [9.34, 45.31], [9.41, 45.25], [9.48, 45.23],
    [9.53, 45.17]
  ],
  "OLONA-LAMBRO MERIDIONALE": [
    [8.85, 45.78], [8.86, 45.75], [8.87, 45.72], [8.88, 45.69], [8.89, 45.66],
    [8.90, 45.63], [8.91, 45.60], [8.92, 45.57], [8.93, 45.54], [8.95, 45.51],
    [8.98, 45.48], [9.02, 45.45], [9.06, 45.42], [9.10, 45.39], [9.14, 45.36],
    [9.18, 45.33], [9.22, 45.30], [9.26, 45.27], [9.30, 45.24], [9.34, 45.21],
    [9.38, 45.18], [9.42, 45.15], [9.46, 45.12], [9.50, 45.10], [9.54, 45.08],
    [9.58, 45.06], [9.62, 45.04], [9.66, 45.02], [9.70, 45.00], [9.74, 44.98],
    [9.78, 44.96], [9.82, 44.94], [9.86, 44.92], [9.90, 44.90], [9.94, 44.88]
  ],
  Po: [
    [7.05, 44.68], [7.35, 44.72], [7.65, 44.85], [8.00, 44.90],
    [8.45, 44.97], [8.85, 45.07], [9.20, 45.13], [9.55, 45.18],
    [9.95, 45.22], [10.35, 45.25], [10.75, 45.20], [11.15, 45.10],
    [11.55, 45.00], [11.95, 44.95], [12.35, 44.95], [12.60, 44.97]
  ],
  "ADDA SUBLACUALE": [
    [9.5, 45.7], [9.45, 45.6], [9.4, 45.5], [9.35, 45.4],
    [9.3, 45.3], [9.25, 45.2], [9.2, 45.1], [9.15, 45.0]
  ],
  "ADDA PRELACUALE": [
    [10.1, 46.25], [10.15, 46.1], [10.2, 45.95], [10.25, 45.8],
    [10.3, 45.65], [10.4, 45.5], [10.5, 45.4], [9.5, 45.7]
  ],
  BREMBO: [
    [9.7, 46.0], [9.65, 45.85], [9.6, 45.7], [9.55, 45.55],
    [9.5, 45.4], [9.45, 45.3], [9.4, 45.5]
  ],
  SERIO: [
    [9.8, 46.1], [9.75, 45.95], [9.7, 45.8], [9.65, 45.65],
    [9.6, 45.5], [9.55, 45.4], [9.5, 45.3]
  ],
  MELLA: [
    [10.2, 46.1], [10.15, 45.95], [10.1, 45.8], [10.05, 45.65],
    [10.0, 45.5], [9.95, 45.4], [10.1, 45.3]
  ],
  MERA: [[9.3, 46.1], [9.25, 46.0], [9.2, 45.85], [9.15, 45.75]],
  MINCIO: [
    [10.7, 45.6], [10.65, 45.5], [10.6, 45.4], [10.55, 45.3],
    [10.5, 45.2], [10.45, 45.1], [10.9, 45.0]
  ],
  "TICINO SUBLACUALE": [
    [8.6, 45.7], [8.65, 45.6], [8.7, 45.5], [8.75, 45.4],
    [8.8, 45.3], [8.85, 45.2], [8.9, 45.1]
  ],
  "OGLIO SUBLACUALE": [
    [10.05, 45.5], [10.0, 45.4], [9.95, 45.3], [9.9, 45.2],
    [9.85, 45.1], [10.2, 45.0]
  ],
  "OGLIO SOPRALACUALE": [
    [10.1, 46.3], [10.05, 46.15], [10.0, 46.0], [9.95, 45.85],
    [9.9, 45.7], [9.85, 45.6], [10.05, 45.5]
  ],
  SEVESO: [
    [9.1, 45.7], [9.12, 45.62], [9.14, 45.54], [9.16, 45.46],
    [9.18, 45.38], [9.2, 45.3]
  ],
  AGOGNA: [[8.6, 45.7], [8.65, 45.55], [8.7, 45.4], [8.75, 45.25]],
  "CHIESE SUBLACUALE": [
    [10.4, 45.7], [10.35, 45.6], [10.3, 45.5], [10.25, 45.4],
    [10.2, 45.3], [10.15, 45.2]
  ],
  "FISSERO-TARTARO": [
    [10.75, 45.35], [10.78, 45.32], [10.80, 45.29], [10.82, 45.26],
    [10.84, 45.23], [10.86, 45.20], [10.88, 45.17], [10.90, 45.14],
    [10.92, 45.11], [10.94, 45.08], [10.96, 45.05], [10.98, 45.02],
    [11.00, 44.99], [11.02, 44.96], [11.04, 44.93], [11.06, 44.90],
    [11.08, 44.87], [11.10, 44.84], [11.12, 44.81], [11.14, 44.78],
    [11.16, 44.75], [11.18, 44.72], [11.20, 44.70]
  ],
  SPOL: [[10.0, 46.4], [10.05, 46.3], [10.1, 46.2]]
};

const BASIN_WFD = {
  LAMBRO: "poor",
  "OLONA-LAMBRO MERIDIONALE": "poor",
  ADDA: "good",
  BREMBO: "moderate",
  SERIO: "moderate",
  TICINO: "good",
  OGLIO: "moderate",
  MELLA: "moderate",
  CHIESE: "good",
  MERA: "good",
  MINCIO: "moderate",
  AGOGNA: "moderate",
  SEVESO: "poor",
  PO: "moderate",
  "FISSERO-TARTARO": "moderate",
  SPOL: "moderate"
};

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

  // 3) build river geometry from stations sorted by lat (north -> south)
  const coords = stations
    .map(s => [s.lon, s.lat])
    .sort((a, b) => b[1] - a[1]);

  const riverId = basin.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  const river = {
    id: riverId,
    name: basin.charAt(0) + basin.slice(1).toLowerCase(),
    region: "Lombardia (ARPA)",
    length_km: null,
    wfd_status: BASIN_WFD[basin] || "moderate",
    source: "ARPA Lombardia",
    geom: {
      type: "LineString",
      coordinates: BASIN_GEOMETRIES[basin] || coords
    }
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