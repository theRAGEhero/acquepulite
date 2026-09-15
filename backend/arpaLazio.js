import { log } from "./logger.js";
import fs from "node:fs";
import path from "node:path";
import { ECOLOGICAL_SCORE, chemicalConstraint, combineScores, scoreToWfd } from "./wfdClassification.js";

export const LAZIO_DATASET_URL = "https://dati.lazio.it/dataset/stato-ecologico-e-stato-chimico-dei-corpi-idrici-di-acque-fluviali";
export const LAZIO_CSV_URL = "https://dati.lazio.it/dataset/1a5e3f3a-5dc1-43c4-adae-6d4451df2d56/resource/fccf2de5-3290-41da-a803-4f5a36e9d6ce/download/stato-ecologico-e-chimico-fiumi-2021-2023.csv";
export const LAZIO_API_URL = "https://dati.lazio.it/api/3/action/datastore_search?resource_id=fccf2de5-3290-41da-a803-4f5a36e9d6ce&limit=500";
const LAZIO_SNAPSHOT_FILE = path.join(import.meta.dirname, "data", "regional", "arpa-lazio-fiumi-2021-2023.csv");


function parseDelimited(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') { field += '"'; index++; }
      else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"') quoted = true;
    else if (character === ";") { row.push(field.trim()); field = ""; }
    else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") index++;
      row.push(field.trim()); field = "";
      if (row.some(Boolean)) rows.push(row);
      row = [];
    } else field += character;
  }
  row.push(field.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

function normalizeHeader(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizedStatus(value, chemical = false) {
  const text = String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!text || text === "n.d." || text === "nd" || text === "in secca") return null;
  if (chemical) return text === "non buono" ? "Non buono" : text === "buono" ? "Buono" : null;
  return ({ elevato: "Elevato", buono: "Buono", sufficiente: "Sufficiente", scarso: "Scarso", cattivo: "Cattivo" })[text] || null;
}

function bodyFromValues({ name, code, station, type, monitoring, ecological: ecologicalRaw, chemical: chemicalRaw }) {
  const ecological = normalizedStatus(ecologicalRaw);
  const chemical = normalizedStatus(chemicalRaw, true);
  const scores = [ECOLOGICAL_SCORE[ecological], chemicalConstraint(chemical)].filter(Number.isFinite);
  return {
    name: String(name || "").trim(),
    waterBodyCode: String(code || "").trim(),
    stationCode: String(station || "").trim() || null,
    waterBodyType: String(type || "").trim() || null,
    monitoringType: String(monitoring || "").trim() || null,
    ecological,
    ecologicalRaw: String(ecologicalRaw || "").trim() || null,
    chemical,
    chemicalRaw: String(chemicalRaw || "").trim() || null,
    score: combineScores(scores)
  };
}

function riverName(waterBodyName) {
  return String(waterBodyName || "").trim().replace(/\s+\d+\s*$/, "").trim();
}

function slug(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

export function parseLazioCsv(text) {
  const rows = parseDelimited(String(text || "").replace(/^\uFEFF/, ""));
  if (rows.length < 2) return [];
  const headers = rows[0].map(normalizeHeader);
  const index = pattern => headers.findIndex(header => pattern.test(header));
  const columns = {
    name: index(/^denominazione corpo idrico$/),
    code: index(/^codice europeo corpo idrico$/),
    station: index(/^codice regionale stazione$/),
    type: index(/^tipologia corpo idrico$/),
    monitoring: index(/^tipologia monitoraggio$/),
    ecological: index(/^stato potenziale ecologico triennio 2021 2023$/),
    chemical: index(/^stato chimico triennio 2021 2023$/)
  };
  if (Object.values(columns).some(column => column < 0)) {
    throw new Error(`Unexpected ARPA Lazio CSV schema: ${rows[0].join(" | ")}`);
  }
  return rows.slice(1).map(row => bodyFromValues({
    name: row[columns.name],
    code: row[columns.code],
    station: row[columns.station],
    type: row[columns.type],
    monitoring: row[columns.monitoring],
    ecological: row[columns.ecological],
    chemical: row[columns.chemical]
  })).filter(body => body.name && body.waterBodyCode && (body.ecological || body.chemical));
}

export function parseLazioRecords(records) {
  return (records || []).map(record => bodyFromValues({
    name: record["Denominazione Corpo Idrico"],
    code: record["Codice Europeo Corpo Idrico"],
    station: record["Codice Regionale Stazione"],
    type: record["Tipologia Corpo Idrico"],
    monitoring: record["Tipologia Monitoraggio"],
    ecological: record["Stato/Potenziale Ecologico triennio 2021-2023"],
    chemical: record["Stato Chimico triennio 2021-2023"]
  })).filter(body => body.name && body.waterBodyCode && (body.ecological || body.chemical));
}

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function fetchWithRetry(url, label, attempts = 2) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "AcquePulite/1.0", Accept: "text/csv, application/json;q=0.9" },
        signal: AbortSignal.timeout(12_000)
      });
      if (response.ok) return response;
      lastError = new Error(`${label} ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) await delay(500 * attempt);
  }
  throw lastError || new Error(`${label} unavailable`);
}

export function buildLazioRivers(bodies) {
  const grouped = new Map();
  for (const body of bodies || []) {
    const name = riverName(body.name);
    const key = name.toLocaleLowerCase("it");
    if (!grouped.has(key)) grouped.set(key, { name, stretches: [] });
    grouped.get(key).stretches.push({
      name: body.name,
      water_body_code: body.waterBodyCode,
      station_code: body.stationCode,
      water_body_type: body.waterBodyType,
      monitoring_type: body.monitoringType,
      comune: body.stationCode ? `Stazione ${body.stationCode}` : null,
      status: body.ecological || body.chemical || "Non classificato",
      ecological: body.ecological,
      ecological_raw: body.ecologicalRaw,
      chemical: body.chemical,
      chemical_raw: body.chemicalRaw,
      score: body.score,
      source_url: LAZIO_DATASET_URL,
      source_download_url: LAZIO_CSV_URL,
      source_license: "CC BY 4.0"
    });
  }
  return [...grouped.values()].map(value => {
    const worst = combineScores(value.stretches.map(stretch => stretch.score));
    return {
      id: `arpalazio_${slug(value.name)}`,
      name: value.name,
      region: "Lazio (ARPA Lazio)",
      source: "ARPA Lazio",
      source_url: LAZIO_DATASET_URL,
      source_download_url: LAZIO_CSV_URL,
      source_license: "CC BY 4.0",
      source_license_url: "https://creativecommons.org/licenses/by/4.0/",
      source_period: "Provisional WFD assessment, monitoring triennium 2021–2023",
      assessment_type: "WFD ecological + chemical status",
      wfd_status: scoreToWfd(worst),
      stretches: value.stretches.sort((a, b) => a.name.localeCompare(b.name, "it")),
      geom: null,
      official_only: true
    };
  }).sort((a, b) => a.name.localeCompare(b.name, "it"));
}

export async function loadArpaLazio() {
  let bodies;
  try {
    bodies = await Promise.any([
      fetchWithRetry(LAZIO_CSV_URL, "ARPA Lazio CSV").then(async response => parseLazioCsv(await response.text())),
      fetchWithRetry(LAZIO_API_URL, "ARPA Lazio datastore API").then(async response => {
        const payload = await response.json();
        if (!payload?.success) throw new Error("ARPA Lazio datastore API returned an unsuccessful payload");
        return parseLazioRecords(payload.result?.records);
      })
    ]);
  } catch (liveError) {
    if (!fs.existsSync(LAZIO_SNAPSHOT_FILE)) throw liveError;
    log.warn("ARPA-LAZIO", "Live CSV and datastore API unavailable; using the versioned official 2021-2023 snapshot", {
      snapshot: path.basename(LAZIO_SNAPSHOT_FILE),
      source_url: LAZIO_DATASET_URL
    });
    bodies = parseLazioCsv(fs.readFileSync(LAZIO_SNAPSHOT_FILE, "utf8"));
  }
  if (!bodies.length) throw new Error("ARPA Lazio CSV returned no classified water bodies");
  const rivers = buildLazioRivers(bodies);
  log.info("ARPA-LAZIO", `Loaded ${rivers.length} rivers from ${bodies.length} classified water bodies`);
  return rivers;
}
