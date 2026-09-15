import { log } from "./logger.js";
import { ECOLOGICAL_SCORE, chemicalConstraint, combineScores, scoreToWfd } from "./wfdClassification.js";

export const FVG_SOURCE_URL = "https://www.arpa.fvg.it/temi/temi/acqua/sezioni-principali/acque-interne/qualita-delle-acque/";
export const FVG_LICENSE_URL = "https://www.arpa.fvg.it/link-footer/link-in-basso-cookie-privacy/note-legali/";


function decodeHtml(value) {
  return String(value || "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/\s+/g, " ")
    .trim();
}

function status(value, chemical = false) {
  const normalized = decodeHtml(value).toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalized || normalized === "sconosciuto" || normalized === "n.d.") return null;
  if (chemical) {
    if (normalized === "non buono") return "Non buono";
    if (normalized === "buono") return "Buono";
    return null;
  }
  if (normalized === "buono e oltre") return "Buono";
  return ({ elevato: "Elevato", buono: "Buono", sufficiente: "Sufficiente", scarso: "Scarso", cattivo: "Cattivo" })[normalized] || null;
}

function slug(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

export function parseFvgWaterBodies(html) {
  const bodies = [];
  for (const rowMatch of String(html || "").matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...rowMatch[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(match => match[1]);
    if (cells.length < 6 || /corpo idrico/i.test(decodeHtml(cells[0]))) continue;
    const regionalCode = decodeHtml(cells[0]);
    const river = decodeHtml(cells[1]);
    const comune = decodeHtml(cells[2]);
    const ecologicalRaw = decodeHtml(cells[3]);
    const chemicalRaw = decodeHtml(cells[4]);
    const waterBodyCode = decodeHtml(cells[5]);
    const ecological = status(ecologicalRaw);
    const chemical = status(chemicalRaw, true);
    const scores = [ECOLOGICAL_SCORE[ecological], chemicalConstraint(chemical)].filter(Number.isFinite);
    // Keep the body whenever either element is classified. A body known only to
    // have compliant chemistry has no overall class, but dropping it would lose
    // a real published fact and silently shrink coverage.
    if (!river || !waterBodyCode || (!ecological && !chemical)) continue;
    const href = cells[0].match(/href=["']([^"']+)["']/i)?.[1] || null;
    bodies.push({
      regionalCode,
      river,
      comune,
      ecological,
      ecologicalRaw: ecologicalRaw || null,
      chemical,
      chemicalRaw: chemicalRaw || null,
      waterBodyCode,
      reportUrl: href ? new URL(href, FVG_SOURCE_URL).href : null,
      score: combineScores(scores)
    });
  }
  return bodies;
}

export function buildFvgRivers(bodies) {
  const grouped = new Map();
  for (const body of bodies || []) {
    const key = body.river.toLocaleLowerCase("it");
    if (!grouped.has(key)) grouped.set(key, { name: body.river, stretches: [] });
    grouped.get(key).stretches.push({
      name: `${body.river} · ${body.comune || body.regionalCode}`,
      water_body_code: body.waterBodyCode,
      regional_code: body.regionalCode || null,
      comune: body.comune || null,
      status: body.ecological || body.chemical || "Non classificato",
      ecological: body.ecological,
      ecological_raw: body.ecologicalRaw,
      chemical: body.chemical,
      chemical_raw: body.chemicalRaw,
      score: body.score,
      source_url: body.reportUrl || FVG_SOURCE_URL,
      source_dataset_url: FVG_SOURCE_URL,
      source_license: "CC BY 4.0"
    });
  }
  return [...grouped.values()].map(value => {
    const worst = combineScores(value.stretches.map(stretch => stretch.score));
    return {
      id: `arpafvg_${slug(value.name)}`,
      name: value.name,
      region: "Friuli-Venezia Giulia (ARPA FVG)",
      source: "ARPA FVG",
      source_url: FVG_SOURCE_URL,
      source_license: "CC BY 4.0",
      source_license_url: FVG_LICENSE_URL,
      source_period: "WFD classification 2014–2019; Water Management Plan 2021–2027",
      assessment_type: "WFD ecological + chemical status",
      wfd_status: scoreToWfd(worst),
      stretches: value.stretches.sort((a, b) => a.name.localeCompare(b.name, "it")),
      geom: null,
      official_only: true
    };
  }).sort((a, b) => a.name.localeCompare(b.name, "it"));
}

export async function loadArpaFvg() {
  const response = await fetch(FVG_SOURCE_URL, { headers: { "User-Agent": "AcquePulite/1.0" } });
  if (!response.ok) throw new Error(`ARPA FVG page ${response.status}`);
  const bodies = parseFvgWaterBodies(await response.text());
  if (!bodies.length) throw new Error("ARPA FVG table schema changed or returned no classified water bodies");
  const rivers = buildFvgRivers(bodies);
  log.info("ARPA-FVG", `Loaded ${rivers.length} rivers from ${bodies.length} classified water bodies`);
  return rivers;
}
