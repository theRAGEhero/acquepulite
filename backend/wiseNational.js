import fs from "node:fs";
import path from "node:path";
import { combineLineGeometries } from "./hydrography.js";
import { log } from "./logger.js";
import {
  WISE_ECOLOGICAL_CODE, WISE_CHEMICAL_CODE, ECOLOGICAL_SCORE, CHEMICAL_SCORE,
  combineScores, scoreToWfd, worstWfd, chemicalConstraint
} from "./wfdClassification.js";

export const WISE_STATUS_URL = "https://water.discomap.eea.europa.eu/arcgis/rest/services/WISE_WFD/WFD2022_SurfaceWaterBody_WM/MapServer/2";
export const WISE_LICENSE_URL = "https://www.eea.europa.eu/en/legal-notice";
export const GISCO_REGIONS_URL = "https://gisco-services.ec.europa.eu/distribution/v2/nuts/nuts-2024-files.html";

const STATUS_FILE = path.join(import.meta.dirname, "data", "regional", "wise-wfd-2022-it-status.json");
const REGIONS_FILE = path.join(import.meta.dirname, "data", "regional", "nuts-2024-it-regions.geojson");

export const ITALIAN_REGIONS = [
  { code: "PIE", name: "Piemonte", nuts: ["ITC1"] },
  { code: "VDA", name: "Valle d'Aosta", nuts: ["ITC2"] },
  { code: "LIG", name: "Liguria", nuts: ["ITC3"] },
  { code: "LOM", name: "Lombardia", nuts: ["ITC4"] },
  { code: "TAA", name: "Trentino-Alto Adige", nuts: ["ITH1", "ITH2"] },
  { code: "VEN", name: "Veneto", nuts: ["ITH3"] },
  { code: "FVG", name: "Friuli-Venezia Giulia", nuts: ["ITH4"] },
  { code: "EMR", name: "Emilia-Romagna", nuts: ["ITH5"] },
  { code: "TOS", name: "Toscana", nuts: ["ITI1"] },
  { code: "UMB", name: "Umbria", nuts: ["ITI2"] },
  { code: "MAR", name: "Marche", nuts: ["ITI3"] },
  { code: "LAZ", name: "Lazio", nuts: ["ITI4"] },
  { code: "ABR", name: "Abruzzo", nuts: ["ITF1"] },
  { code: "MOL", name: "Molise", nuts: ["ITF2"] },
  { code: "CAM", name: "Campania", nuts: ["ITF3"] },
  { code: "PUG", name: "Puglia", nuts: ["ITF4"] },
  { code: "BAS", name: "Basilicata", nuts: ["ITF5"] },
  { code: "CAL", name: "Calabria", nuts: ["ITF6"] },
  { code: "SIC", name: "Sicilia", nuts: ["ITG1"] },
  { code: "SAR", name: "Sardegna", nuts: ["ITG2"] }
];

const REGION_BY_NUTS = new Map(ITALIAN_REGIONS.flatMap(region =>
  region.nuts.map(nuts => [nuts, region])));
const REGION_BY_CODE = new Map(ITALIAN_REGIONS.map(region => [region.code, region]));

// Built from the shared classification tables so WISE cannot drift from the
// regional adapters: same labels, same scores, same score->class function.
const ECOLOGICAL = Object.fromEntries(Object.entries(WISE_ECOLOGICAL_CODE).map(
  ([code, label]) => [code, { label, wfd: scoreToWfd(ECOLOGICAL_SCORE[label]), score: ECOLOGICAL_SCORE[label] }]
));
const CHEMICAL = Object.fromEntries(Object.entries(WISE_CHEMICAL_CODE).map(
  ([code, label]) => [code, { label, score: CHEMICAL_SCORE[label] }]
));

function normalizedCode(value) {
  return String(value || "").replace(/[^a-z0-9]/gi, "").toUpperCase();
}

function normalizedName(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/gi, "").toUpperCase();
}

function cleanRiverName(value, fallback) {
  const cleaned = String(value || "").trim()
    .replace(/\s+(?:RIVER|STREAM|TORRENT)?\s*SECTION\b.*$/i, "")
    .replace(/\s+(?:FIUME|TORRENTE)?\s*TRATTO\b.*$/i, "")
    .replace(/\s+CI[-_ ].*$/i, "")
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const name = cleaned || String(fallback || "Corpo idrico");
  return name.toLocaleLowerCase("it").replace(/(^|[\s'’-])\p{L}/gu, letter => letter.toLocaleUpperCase("it"));
}

function pointInRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects = ((yi > point[1]) !== (yj > point[1])) &&
      point[0] < ((xj - xi) * (point[1] - yi)) / ((yj - yi) || Number.EPSILON) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointInPolygon(point, coordinates) {
  if (!coordinates?.length || !pointInRing(point, coordinates[0])) return false;
  return !coordinates.slice(1).some(ring => pointInRing(point, ring));
}

function pointInGeometry(point, geometry) {
  if (geometry?.type === "Polygon") return pointInPolygon(point, geometry.coordinates);
  if (geometry?.type === "MultiPolygon") return geometry.coordinates.some(polygon => pointInPolygon(point, polygon));
  return false;
}

function sampleGeometry(geometry, maximum = 30) {
  const lines = geometry?.type === "LineString" ? [geometry.coordinates]
    : geometry?.type === "MultiLineString" ? geometry.coordinates : [];
  const points = [];
  for (const line of lines) {
    if (!line.length) continue;
    const step = Math.max(1, Math.floor(line.length / maximum));
    for (let index = 0; index < line.length; index += step) points.push(line[index]);
    points.push(line[line.length - 1]);
  }
  return points;
}

export function regionCodesForGeometry(geometry, regionFeatures) {
  const found = new Set();
  for (const point of sampleGeometry(geometry)) {
    for (const feature of regionFeatures || []) {
      if (!pointInGeometry(point, feature.geometry)) continue;
      const region = REGION_BY_NUTS.get(feature.properties?.NUTS_ID);
      if (region) found.add(region.code);
    }
  }
  return [...found].sort();
}

export function normalizeWiseStatus(record) {
  const ecological = ECOLOGICAL[String(record.swEcologicalStatusOrPotentialValue || "").trim()] || null;
  const chemical = CHEMICAL[String(record.swChemicalStatusValue || "").trim()] || null;
  const score = combineScores([ecological?.score, chemicalConstraint(chemical?.label)]);
  return { ecological, chemical, score, wfd: scoreToWfd(score) };
}

function loadSnapshots() {
  if (!fs.existsSync(STATUS_FILE) || !fs.existsSync(REGIONS_FILE)) {
    throw new Error("National snapshots are missing; run node fetchNationalBaseline.mjs");
  }
  return {
    status: JSON.parse(fs.readFileSync(STATUS_FILE, "utf8")),
    regions: JSON.parse(fs.readFileSync(REGIONS_FILE, "utf8"))
  };
}

export function loadWiseNationalRivers(catalog, excludedRegionCodes = new Set()) {
  const { status, regions } = loadSnapshots();
  const grouped = new Map();
  let unmatchedGeometry = 0;
  let outsideRegions = 0;
  let excluded = 0;

  for (const record of status.records || []) {
    const code = String(record.euSurfaceWaterBodyCode || "").trim();
    const matches = catalog.byCode.get(normalizedCode(code)) || [];
    const geometry = combineLineGeometries(matches.map(match => match.feature.geometry));
    if (!geometry) { unmatchedGeometry++; continue; }
    const regionCodes = regionCodesForGeometry(geometry, regions.features);
    if (!regionCodes.length) { outsideRegions++; continue; }
    if (regionCodes.some(regionCode => excludedRegionCodes.has(regionCode))) { excluded++; continue; }

    const classification = normalizeWiseStatus(record);
    const riverName = cleanRiverName(record.surfaceWaterBodyName, code);
    const key = `${regionCodes.join("+")}:${normalizedName(riverName) || normalizedCode(code)}`;
    if (!grouped.has(key)) grouped.set(key, { name: riverName, regionCodes: new Set(), stretches: [], geometries: [], length: 0 });
    const group = grouped.get(key);
    regionCodes.forEach(regionCode => group.regionCodes.add(regionCode));
    group.geometries.push(geometry);
    group.length += Number(record.cLength) || Number(matches[0]?.feature?.properties?.sizeValue) || 0;
    group.stretches.push({
      name: String(record.surfaceWaterBodyName || riverName),
      water_body_code: code,
      status: classification.ecological?.label || classification.chemical?.label || "Non classificato",
      ecological: classification.ecological?.label || null,
      chemical: classification.chemical?.label || null,
      ecological_assessment_year: record.swEcologicalAssessmentYear || null,
      chemical_assessment_year: record.swChemicalAssessmentYear || null,
      ecological_confidence: record.swEcologicalAssessmentConfidence || null,
      chemical_confidence: record.swChemicalAssessmentConfidence || null,
      score: classification.score,
      geometry,
      geometry_source: matches[0].dataset.title || matches[0].dataset.id,
      source_feature_id: code,
      geometry_match: "water-body-code",
      requires_review: false,
      source_url: WISE_STATUS_URL,
      source_license: "EEA standard re-use policy / CC BY 4.0"
    });
  }

  const rivers = [...grouped.values()].map(group => {
    const regionCodes = [...group.regionCodes].sort();
    const statuses = group.stretches.map(stretch => normalizeWiseStatus({
      swEcologicalStatusOrPotentialValue: Object.entries(ECOLOGICAL).find(([, value]) => value.label === stretch.ecological)?.[0],
      swChemicalStatusValue: Object.entries(CHEMICAL).find(([, value]) => value.label === stretch.chemical)?.[0]
    }).wfd).filter(Boolean);
    const wfdStatus = worstWfd(statuses);
    const names = regionCodes.map(code => REGION_BY_CODE.get(code)?.name).filter(Boolean);
    const idCode = group.stretches[0]?.water_body_code || `${regionCodes.join("_")}_${normalizedName(group.name)}`;
    return {
      id: `wise_${normalizedCode(idCode).toLowerCase()}`,
      name: group.name,
      region: names.join(" / "),
      region_code: regionCodes[0] || null,
      region_codes: regionCodes,
      region_source_url: GISCO_REGIONS_URL,
      source: "EEA WISE WFD 2022",
      source_url: WISE_STATUS_URL,
      source_license: "EEA standard re-use policy / CC BY 4.0",
      source_license_url: WISE_LICENSE_URL,
      source_period: "Third River Basin Management Plan reporting (2022 dataset)",
      assessment_type: "WFD ecological + chemical status (national baseline)",
      water_body_code: group.stretches.length === 1 ? group.stretches[0].water_body_code : null,
      length_km: group.length > 0 ? Number(group.length.toFixed(1)) : null,
      wfd_status: wfdStatus,
      stretches: group.stretches,
      geom: combineLineGeometries(group.geometries),
      geometry_source: group.stretches[0]?.geometry_source || "WISE WFD 2022 SurfaceWaterBodyLine",
      source_dataset_version: status.metadata?.version || "2022",
      source_feature_id: group.stretches.map(stretch => stretch.water_body_code).join(","),
      geometry_quality: "official",
      topology: { components: group.geometries.length, artificial_connectors: 0 },
      official_only: true,
      geometry_locked: true,
      national_baseline: true
    };
  });

  const regionCounts = Object.fromEntries(ITALIAN_REGIONS.map(region => [region.code, 0]));
  for (const river of rivers) for (const code of river.region_codes) regionCounts[code]++;
  log.info("WISE-NATIONAL", `Loaded ${rivers.length} rivers for ${Object.values(regionCounts).filter(Boolean).length} fallback regions`, {
    status_records: status.records?.length || 0,
    excluded_records: excluded,
    unmatched_geometry: unmatchedGeometry,
    outside_regions: outsideRegions,
    region_counts: regionCounts
  });
  return { rivers, metadata: status.metadata, regionCounts };
}
