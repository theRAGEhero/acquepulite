import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const DATA_DIR = path.join(import.meta.dirname, "data", "regional");
const STATUS_FILE = path.join(DATA_DIR, "wise-wfd-2022-it-status.json");
const REGIONS_FILE = path.join(DATA_DIR, "nuts-2024-it-regions.geojson");
const WISE_LAYER = "https://water.discomap.eea.europa.eu/arcgis/rest/services/WISE_WFD/WFD2022_SurfaceWaterBody_WM/MapServer/2";
const NUTS_URL = "https://gisco-services.ec.europa.eu/distribution/v2/nuts/geojson/NUTS_RG_20M_2024_4326_LEVL_2.geojson";
const PAGE_SIZE = 2000;

async function fetchJson(url, label) {
  const response = await fetch(url, {
    headers: { "User-Agent": "AcquePulite/1.0", Accept: "application/json" },
    signal: AbortSignal.timeout(60_000)
  });
  if (!response.ok) throw new Error(`${label} returned ${response.status}`);
  return response.json();
}

async function fetchWiseRecords() {
  const records = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const query = new URL(`${WISE_LAYER}/query`);
    query.search = new URLSearchParams({
      where: "countryCode='IT'",
      outFields: [
        "OBJECTID", "cYear", "countryCode", "euRBDCode", "euSubUnitCode",
        "euSurfaceWaterBodyCode", "surfaceWaterBodyName", "cLength", "naturalAWBHMWB",
        "swEcologicalStatusOrPotentialValue", "swEcologicalAssessmentYear",
        "swEcologicalAssessmentConfidence", "swChemicalStatusValue",
        "swChemicalAssessmentYear", "swChemicalAssessmentConfidence",
        "swChemicalStatusValueWithoutUPBT"
      ].join(","),
      returnGeometry: "false",
      orderByFields: "OBJECTID ASC",
      resultOffset: String(offset),
      resultRecordCount: String(PAGE_SIZE),
      f: "json"
    }).toString();
    const payload = await fetchJson(query, `EEA WISE page ${offset / PAGE_SIZE + 1}`);
    if (payload.error) throw new Error(`EEA WISE: ${payload.error.message || "query failed"}`);
    const page = (payload.features || []).map(feature => feature.attributes || feature.properties || {});
    records.push(...page);
    process.stdout.write(`EEA WISE: ${records.length} Italian river water bodies\n`);
    if (page.length < PAGE_SIZE && !payload.exceededTransferLimit) break;
  }
  if (records.length < 5000) throw new Error(`EEA WISE validation failed: only ${records.length} Italian records`);
  if (new Set(records.map(record => record.euSurfaceWaterBodyCode).filter(Boolean)).size < 5000) {
    throw new Error("EEA WISE validation failed: too few unique water-body codes");
  }
  return records;
}

function writeJsonAtomic(file, value) {
  const temp = `${file}.tmp`;
  const json = `${JSON.stringify(value)}\n`;
  fs.writeFileSync(temp, json, "utf8");
  fs.renameSync(temp, file);
  return createHash("sha256").update(json).digest("hex");
}

fs.mkdirSync(DATA_DIR, { recursive: true });
const [records, nuts] = await Promise.all([
  fetchWiseRecords(),
  fetchJson(NUTS_URL, "Eurostat GISCO NUTS regions")
]);

const italianRegions = {
  type: "FeatureCollection",
  features: (nuts.features || []).filter(feature => feature.properties?.CNTR_CODE === "IT")
};
if (italianRegions.features.length < 20) {
  throw new Error(`GISCO validation failed: expected at least 20 Italian NUTS-2 units, got ${italianRegions.features.length}`);
}

const downloadedAt = new Date().toISOString();
const statusHash = writeJsonAtomic(STATUS_FILE, {
  metadata: {
    id: "wise-wfd-2022-it-river-status",
    title: "WISE WFD 2022 Italian river ecological and chemical status",
    source_url: WISE_LAYER,
    version: "2022 third River Basin Management Plan",
    license: "EEA standard re-use policy / CC BY 4.0",
    downloaded_at: downloadedAt,
    records: records.length
  },
  records
});
const regionHash = writeJsonAtomic(REGIONS_FILE, {
  ...italianRegions,
  metadata: {
    id: "eurostat-gisco-nuts-2024-it-level-2",
    source_url: NUTS_URL,
    version: "NUTS 2024",
    downloaded_at: downloadedAt
  }
});

process.stdout.write(`${JSON.stringify({
  status_file: path.relative(import.meta.dirname, STATUS_FILE),
  status_records: records.length,
  status_sha256: statusHash,
  regions_file: path.relative(import.meta.dirname, REGIONS_FILE),
  nuts_units: italianRegions.features.length,
  regions_sha256: regionHash
}, null, 2)}\n`);
