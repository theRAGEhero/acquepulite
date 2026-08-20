// ARPAE Emilia-Romagna adapter — real water quality data from dati.arpae.it
// (Google Sheets exports, CC-BY 4.0). Includes:
//   - monitoraggio_fiumi.csv   : measurements per station 2010-2025 (11MB)
//   - anagrafica_stazioni.csv  : station registry with lat/lon, river (ASTA)
//
// Files placed in ./data/arpae/ by the setup script.

import fs from "node:fs";
import path from "node:path";
import { log } from "./logger.js";

const DATA_DIR = path.join(import.meta.dirname, "data", "arpae");

// Param name in CSV → our param code (with legal limits in mg/L or µg/L)
const PARAM_COLS = {
  "Azoto Nitrico": { code: "NO3", name: "Nitrates (as N)", unit: "mg/L", legal_limit: 10 },
  "Azoto ammoniacale": { code: "NH4", name: "Ammonia", unit: "mg/L N", legal_limit: 0.5 },
  "Ortofosfato": { code: "PO4", name: "Orthophosphate", unit: "mg/L P", legal_limit: 0.2 },
  "Fosforo totale": { code: "PTOT", name: "Total Phosphorus", unit: "mg/L P", legal_limit: 0.2 },
  "Escherichia coli": { code: "EC", name: "Escherichia coli", unit: "MPN/100mL", legal_limit: 500 },
  "Piombo": { code: "PB", name: "Lead", unit: "\u00b5g/L", legal_limit: 10 },
  "Nichel": { code: "NI", name: "Nickel", unit: "\u00b5g/L", legal_limit: 20 },
  "Cromo totale": { code: "CR", name: "Chromium (total)", unit: "\u00b5g/L", legal_limit: 50 },
  "Cadmio": { code: "CD", name: "Cadmium", unit: "\u00b5g/L", legal_limit: 0.25 },
  "Arsenico": { code: "AS", name: "Arsenic", unit: "\u00b5g/L", legal_limit: 10 },
  "Mercurio": { code: "HG", name: "Mercury", unit: "\u00b5g/L", legal_limit: 0.05 },
  "B_O_D_5": { code: "BOD5", name: "BOD5", unit: "mg/L O2", legal_limit: 5 },
  "C_O_D_": { code: "COD", name: "COD", unit: "mg/L O2", legal_limit: 30 },
  "Ossigeno disciolto O_2": { code: "DO", name: "Dissolved Oxygen", unit: "mg/L", legal_limit: null }
};

// Simple CSV parser (handles quoted fields and BOM)
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some(f => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some(f => f.trim() !== "")) rows.push(row);
  return rows;
}

// "<0.01" → 0.01 (below detection limit → treat as the limit value)
function toNum(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (s === "") return null;
  const cleaned = s.replace(/[<>]/g, "").trim();
  const n = Number(cleaned.replace(",", "."));
  return isFinite(n) ? n : null;
}

// Parse DD/MM/YYYY → YYYY-MM-DD
function toIsoDate(d) {
  const m = String(d).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return String(d).slice(0, 10);
  return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

// Main loader. Returns { rivers, stations, measurementsByStation }
export async function loadArpaeEmiliaRomagna() {
  const anagFile = path.join(DATA_DIR, "anagrafica_stazioni.csv");
  const dataFile = path.join(DATA_DIR, "monitoraggio_fiumi.csv");

  if (!fs.existsSync(anagFile) || !fs.existsSync(dataFile)) {
    log.warn("ARPAE", "Data files missing — run scripts/fetch_arpae.ps1 to download them.");
    return { rivers: [], stations: [], measurementsByStation: new Map() };
  }

  // 1. Anagrafica: stazione id → {id, name, lat, lon, asta}
  const anagRows = parseCSV(fs.readFileSync(anagFile, "utf8").replace(/^\uFEFF/, ""));
  const headerA = anagRows[0].map(h => h.trim());
  const idxStaz = headerA.indexOf("STAZIONE");
  const idxDenom = headerA.indexOf("DENOM");
  const idxLat = headerA.indexOf("LAT");
  const idxLon = headerA.indexOf("LON");
  const idxAsta = headerA.indexOf("ASTA");

  const stationMeta = new Map();
  for (const row of anagRows.slice(1)) {
    const st = (row[idxStaz] || "").trim();
    if (!st) continue;
    const lat = toNum(row[idxLat]);
    const lon = toNum(row[idxLon]);
    stationMeta.set(st, {
      id: st,
      name: (row[idxDenom] || st).trim(),
      lat, lon,
      asta: (row[idxAsta] || "").trim()
    });
  }
  log.info("ARPAE", `Anagrafica: ${stationMeta.size} stations`);

  // 2. Monitoraggio: values per station (paramCode → [{value, timestamp}])
  const raw = fs.readFileSync(dataFile, "utf8").replace(/^\uFEFF/, "");
  const rows = parseCSV(raw);
  // Header layout: row0 = param names, row1 = units, data from row2
  const header = rows[0].map(h => h.trim());
  const dataRows = rows.slice(2); // skip units row

  // Determine column index per param
  const colIdx = {};
  for (const [csvName, cfg] of Object.entries(PARAM_COLS)) {
    const idx = header.indexOf(csvName);
    if (idx !== -1) colIdx[idx] = cfg;
  }
  // Column 0 = station code
  // Column 2 = date (DD/MM/YYYY)

  const measurementsByStation = new Map();
  for (const row of dataRows) {
    const stId = (row[0] || "").trim();
    if (!stId) continue;
    const date = toIsoDate(row[2]);
    for (const [idx, cfg] of Object.entries(colIdx)) {
      const raw = row[Number(idx)];
      const val = toNum(raw);
      if (val == null) continue;
      if (!measurementsByStation.has(stId)) measurementsByStation.set(stId, new Map());
      const m = measurementsByStation.get(stId);
      if (!m.has(cfg.code)) m.set(cfg.code, []);
      m.get(cfg.code).push({ value: val, timestamp: date });
    }
  }
  log.info("ARPAE", `Measurements: ${measurementsByStation.size} stations with data`);

  // 3. Build rivers grouped by ASTA (main watercourse)
  const astaStations = new Map();
  for (const [stId, meta] of stationMeta) {
    const asta = meta.asta || "Fiume";
    if (!astaStations.has(asta)) astaStations.set(asta, []);
    astaStations.get(asta).push(meta);
  }

  const rivers = [];
  const stations = [];
  for (const [asta, stns] of astaStations) {
    // Only include astas that have real measurements
    const withData = stns.filter(s => measurementsByStation.has(s.id));
    if (withData.length === 0) continue;

    // name: strip "F. " prefix → e.g. "F. PO" → "Po"
    const name = asta.replace(/^F\.\s*/i, "").replace(/\s+/g, " ").trim();
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "_");

    rivers.push({
      id: "arpae_" + slug,
      name,
      region: "Emilia-Romagna (ARPAE)",
      source: "ARPAE Emilia-Romagna",
      source_url: "https://dati.arpae.it/dataset/rete-regionale-per-la-qualita-ambientale-acque-superficiali-fluviali-dati-2010-2025",
      source_license: "CC BY 4.0",
      source_license_url: "https://creativecommons.org/licenses/by/4.0/",
      source_period: "Measurements 2010–2025",
      assessment_type: "Measured parameters compared with configured environmental thresholds",
      wfd_status: null,
      geom: null, // geometry comes from OSM in server boot
      stretches: null
    });

    for (const s of withData) {
      stations.push({
        id: "arpae_" + s.id,
        river_id: "arpae_" + slug,
        name: s.name,
        lat: s.lat,
        lon: s.lon,
        arpa: true,
        source: "ARPAE"
      });
      // Re-key measurements
      const meas = measurementsByStation.get(s.id);
      measurementsByStation.delete(s.id);
      measurementsByStation.set("arpae_" + s.id, meas);
    }
  }

  log.info("ARPAE", `Emilia-Romagna: ${rivers.length} rivers (astate), ${stations.length} stations`);
  return { rivers, stations, measurementsByStation };
}
