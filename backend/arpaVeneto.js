import { log } from "./logger.js";
import { ECOLOGICAL_SCORE, combineScores, scoreToWfd } from "./wfdClassification.js";

export const VENETO_SOURCE_PAGE = "https://www.arpa.veneto.it/dati-ambientali/open-data/idrosfera/corsi-dacqua/limeco-livello-di-inquinamento-espresso-dai-macrodescrittori-per-lo-stato-ecologico-dei-corsi-dacqua";
const CSV_URL = "https://www.arpa.veneto.it/dati-ambientali/open-data/file-e-allegati/acque-interne/fiumi_limeco_serie_storica_opendata.csv/@@download/file";

function parseDelimited(text) {
  const firstLine = text.split(/\r?\n/, 1)[0];
  const delimiter = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ";" : ",";
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') { field += '"'; index++; }
      else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"') quoted = true;
    else if (character === delimiter) { row.push(field.trim()); field = ""; }
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

function normalized(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function column(headers, patterns) {
  return headers.findIndex(header => patterns.some(pattern => pattern.test(normalized(header))));
}

function limecoClass(rawClass, rawScore) {
  const text = String(rawClass || "").trim();
  if (/elevato/i.test(text)) return "Elevato";
  if (/buono/i.test(text)) return "Buono";
  if (/sufficiente/i.test(text)) return "Sufficiente";
  if (/scarso/i.test(text)) return "Scarso";
  if (/cattivo/i.test(text)) return "Cattivo";
  const score = Number(String(rawScore || "").replace(",", "."));
  if (!Number.isFinite(score)) return null;
  if (score >= 0.66) return "Elevato";
  if (score >= 0.5) return "Buono";
  if (score >= 0.33) return "Sufficiente";
  if (score >= 0.17) return "Scarso";
  return "Cattivo";
}

export async function loadArpaVeneto() {
  const response = await fetch(CSV_URL, { headers: { "User-Agent": "RiverWatch-Italy/1.0" } });
  if (!response.ok) throw new Error(`ARPA Veneto CSV ${response.status}`);
  const rows = parseDelimited((await response.text()).replace(/^\uFEFF/, ""));
  if (rows.length < 2) return [];
  const headers = rows[0];
  const indexes = {
    year: column(headers, [/^anno$/, /year/]),
    river: column(headers, [/corso d acqua/, /^fiume$/, /^asta$/]),
    body: column(headers, [/nome del corpo idrico/, /denominazione.*corpo/]),
    code: column(headers, [/cod.*corpo/, /codice ci/, /wise/]),
    basin: column(headers, [/bacino/]),
    className: column(headers, [/classe.*limeco/, /livello.*limeco/, /giudizio.*limeco/]),
    score: column(headers, [/punteggio.*limeco/, /^limeco$/, /valore.*limeco/])
  };
  if (indexes.river < 0 && indexes.body >= 0) indexes.river = indexes.body;
  if (indexes.river < 0 || (indexes.className < 0 && indexes.score < 0)) {
    throw new Error(`Unexpected ARPA Veneto CSV schema: ${headers.join(" | ")}`);
  }

  const latestByBody = new Map();
  for (const row of rows.slice(1)) {
    const river = String(row[indexes.river] || "").trim();
    if (!river) continue;
    const body = String(row[indexes.body] || row[indexes.code] || river).trim();
    const status = limecoClass(row[indexes.className], row[indexes.score]);
    if (!status) continue;
    const year = Number(row[indexes.year]) || 0;
    const key = `${normalized(river)}:${normalized(body)}`;
    if (!latestByBody.has(key) || latestByBody.get(key).year <= year) {
      latestByBody.set(key, { river, body, year, status, row });
    }
  }

  const grouped = new Map();
  for (const item of latestByBody.values()) {
    const key = normalized(item.river);
    if (!grouped.has(key)) grouped.set(key, { name: item.river, stretches: [] });
    grouped.get(key).stretches.push({
      name: item.body, water_body_code: indexes.code >= 0 ? item.row[indexes.code] || null : null,
      comune: indexes.basin >= 0 ? item.row[indexes.basin] || null : null,
      status: item.status, ecological: null, chemical: null,
      indicator: "LIMeco", indicator_year: item.year || null,
      score: ECOLOGICAL_SCORE[item.status] ?? null, source_url: VENETO_SOURCE_PAGE
    });
  }
  const rivers = [...grouped.entries()].map(([key, value]) => {
    const worst = combineScores(value.stretches.map(stretch => stretch.score));
    return {
      id: `arpav_${key.replace(/[^a-z0-9]+/g, "_")}`, name: value.name,
      region: "Veneto (ARPAV)", source: "ARPA Veneto (ARPAV)",
      source_url: VENETO_SOURCE_PAGE, source_license: "CC BY 4.0",
      source_license_url: "https://creativecommons.org/licenses/by/4.0/",
      source_period: "LIMeco series 2010–2025; latest observation per water body",
      assessment_type: "LIMeco nutrient/oxygen indicator (not complete WFD status)",
      wfd_status: scoreToWfd(worst),
      stretches: value.stretches, geom: null, official_only: true
    };
  });
  log.info("ARPA-VENETO", `Loaded ${rivers.length} rivers and ${latestByBody.size} latest LIMeco records`);
  return rivers;
}
