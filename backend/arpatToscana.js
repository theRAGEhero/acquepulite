// ARPAT Toscana adapter — real water quality data from dati.toscana.it (CKAN).
// Datasets: "Bacino Arno/Serchio/Ombrone grossetano - Stato ecologico e chimico
// delle acque superficiali" (CSV, CC-BY 4.0).
//
// The CSVs contain per-water-body (corpo idrico) ecological & chemical status
// for triennial periods (2010-2024). Each row = a river stretch with a
// municipality. We derive per-tract pollution coloring from the latest
// triennium (2022-2024).

import { log } from "./logger.js";

const STATUS_SCORE = {
  "Elevato": 0.05,
  "Buono": 0.2,
  "Sufficiente": 0.45,
  "Scarso": 0.7,
  "Cattivo": 0.95
};

const CHEMICAL_SCORE = {
  "Buono": 0.2,
  "Non buono": 0.75
};

const CSV_URLS = {
  arno: "https://www.arpat.toscana.it/app/uploads/datiemappe/dati/bacino-arno-stato-ecologico-e-chimico-delle-acque-superficiali/bacino-arno-2010-2024.csv",
  serchio: "https://www.arpat.toscana.it/app/uploads/datiemappe/dati/bacino-serchio-stato-ecologico-e-chimico-delle-acque-superficiali/bacino-serchio-2010-2024.csv",
  ombrone: "https://www.arpat.toscana.it/app/uploads/datiemappe/dati/bacino-ombrone-grossetano-stato-ecologico-e-chimico-delle-acque-superficiali/bacino-ombrone-grossetano-2010-2024.csv",
  toscana_nord: "https://www.arpat.toscana.it/app/uploads/datiemappe/dati/bacino-toscana-nord-stato-ecologico-e-chimico-delle-acque-superficiali/bacino-toscana-nord-2010-2024.csv"
};

// Simple CSV parser that handles quoted fields and BOM
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
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field); field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some(f => f.trim() !== "")) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some(f => f.trim() !== "")) rows.push(row);
  return rows;
}

async function fetchCSV(basin) {
  const url = CSV_URLS[basin];
  if (!url) return null;
  const res = await fetch(url, { headers: { "User-Agent": "RiverPollutionMap/1.0" } });
  if (!res.ok) throw new Error(`ARPAT ${res.status} for ${basin}`);
  const text = await res.text();
  return parseCSV(text.replace(/^\uFEFF/, ""));
}

// Returns { header, data } — skips title lines, finds the header row.
function extractDataRows(rows) {
  const headerIdx = rows.findIndex(r => r[0] && r[0].trim() === "Sottobacino");
  if (headerIdx === -1) return { header: null, data: [] };
  return {
    header: rows[headerIdx].map(h => h.trim()),
    data: rows.slice(headerIdx + 1)
  };
}

// Build river entries with per-stretch statuses from ARPAT CSVs.
// Returns array of: { id, name, region, wfd_status, stretches: [...] }
export async function loadArpatToscana() {
  const rivers = new Map();

  for (const basin of Object.keys(CSV_URLS)) {
    try {
      log.info("ARPAT", `Fetching ${basin} basin data…`);
      const rows = await fetchCSV(basin);
      if (!rows || rows.length === 0) { log.warn("ARPAT", `No data for ${basin}`); continue; }
      const { header, data } = extractDataRows(rows);
      if (!header) { log.warn("ARPAT", `No header in ${basin}`); continue; }

      // Column layout:
      // 0 Sottobacino, 1 Corpo idrico, 2 Provincia, 3 Comune, 4 Cod.,
      // 5-9 Stato ecologico (5 triennia), 10-14 Stato chimico,
      // 15-19 Biota
      const ecoIdx = 9;  // 2022-2024 stato ecologico
      const chemIdx = 14; // 2022-2024 stato chimico

      let parsed = 0;
      for (const row of data) {
        if (!row[1]) continue;
        const bodyName = row[1].trim();
        const comune = (row[3] || "").trim();
        const waterBodyCode = (row[4] || "").trim();
        // Status values may have annotations like "Cattivo *" — strip them
        const ecoRaw = (row[ecoIdx] || "").trim().replace(/\s*\*+.*$/, "").trim();
        const chemRaw = (row[chemIdx] || "").trim().replace(/\s*\*+.*$/, "").trim();
        const eco = ecoRaw;
        const chem = chemRaw;
        const componentScores = [STATUS_SCORE[eco], CHEMICAL_SCORE[chem]].filter(value => value != null);
        const score = componentScores.length ? Math.max(...componentScores) : null;
        if (score == null) continue;

        // Main watercourse = first part of sottobacino (e.g. "Arno-Arno" → "Arno")
        const mainName = (row[0] || bodyName).split("-")[0].trim();
        const riverKey = mainName.toLowerCase();

        if (!rivers.has(riverKey)) {
          rivers.set(riverKey, { name: mainName, stretches: [] });
        }
        rivers.get(riverKey).stretches.push({
          name: bodyName,
          water_body_code: waterBodyCode || null,
          comune,
          status: eco || chem || "—",
          ecological: eco || null,
          chemical: chem || null,
          score,
          source_url: CSV_URLS[basin],
          source_license: "CC BY 4.0"
        });
        parsed++;
      }
      log.info("ARPAT", `${basin}: ${parsed} water bodies parsed`);
    } catch (e) {
      log.warn("ARPAT", `Failed ${basin}: ${e.message}`);
    }
  }

  const result = [];
  for (const [key, v] of rivers) {
    if (v.stretches.length === 0) continue;
    const first = v.stretches[0];
    const worstScore = Math.max(...v.stretches.map(stretch => stretch.score).filter(Number.isFinite));
    result.push({
      id: "arpat_" + key,
      name: v.name,
      region: "Toscana (ARPAT)",
      source: "ARPAT Toscana",
      source_url: first.source_url,
      source_license: "CC BY 4.0",
      source_license_url: "https://creativecommons.org/licenses/by/4.0/",
      source_period: "2022–2024 triennium",
      assessment_type: "WFD ecological + chemical status",
      // A river overview must not hide its worst classified water body.
      wfd_status: scoreToWfd(worstScore),
      stretches: v.stretches.sort((a, b) => a.name.localeCompare(b.name))
    });
  }
  log.info(`ARPAT`, `Loaded ${result.length} rivers with real Toscana status data`);
  return result;
}

function scoreToWfd(score) {
  if (!Number.isFinite(score)) return null;
  if (score >= 0.85) return "bad";
  if (score >= 0.65) return "poor";
  if (score >= 0.4) return "moderate";
  if (score >= 0.1) return "good";
  return "high";
}

export function arpatRiverScore(river, index) {
  if (!river.stretches || river.stretches.length === 0) return null;
  const st = river.stretches[index % river.stretches.length];
  return st ? st.score : null;
}
