import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DATASET_ID = "wise-wfd-2022-it";
const VERSION = "2022-v1.7-2024-07";
const PAGE_SIZE = 500;
const SERVICE = "https://water.discomap.eea.europa.eu/arcgis/rest/services/WISE_WFD/WFD2022_SurfaceWaterBody_WM/MapServer/16";
const outputDir = path.join(import.meta.dirname, "data", "hydrography");
const outputFile = path.join(outputDir, `${DATASET_ID}.geojson`);
const manifestFile = path.join(outputDir, "manifest.json");

async function getJson(url) {
  const response = await fetch(url, { headers: { "User-Agent": "RiverPollutionMap/2.0" } });
  if (!response.ok) throw new Error(`EEA WISE HTTP ${response.status}`);
  const data = await response.json();
  if (data.error) throw new Error(`EEA WISE: ${data.error.message}`);
  return data;
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true });
  const where = "countryCode='IT'";
  const idsUrl = `${SERVICE}/query?where=${encodeURIComponent(where)}&returnIdsOnly=true&f=json`;
  const idResult = await getJson(idsUrl);
  const objectIds = idResult.objectIds || [];
  const count = objectIds.length;
  if (!count) throw new Error("EEA WISE returned no Italian river-line IDs");

  const features = [];
  for (let offset = 0; offset < count; offset += PAGE_SIZE) {
    const pageIds = objectIds.slice(offset, offset + PAGE_SIZE);
    const params = new URLSearchParams({
      objectIds: pageIds.join(","),
      outFields: "*",
      returnGeometry: "true",
      outSR: "4326",
      f: "geojson"
    });
    const page = await getJson(`${SERVICE}/query?${params}`);
    const valid = (page.features || []).filter(feature =>
      feature.geometry?.type === "LineString" || feature.geometry?.type === "MultiLineString"
    );
    features.push(...valid);
    console.log(`WISE WFD: ${Math.min(offset + PAGE_SIZE, count)}/${count}`);
  }
  if (features.length !== count) {
    throw new Error(`Expected ${count} line features, received ${features.length}`);
  }

  const collection = {
    type: "FeatureCollection",
    name: "WISE WFD 2022 SurfaceWaterBodyLine — Italy",
    metadata: { dataset_id: DATASET_ID, version: VERSION, source: SERVICE, downloaded_at: new Date().toISOString() },
    features
  };
  const json = JSON.stringify(collection);
  const checksum = crypto.createHash("sha256").update(json).digest("hex");
  const temporary = `${outputFile}.tmp`;
  fs.writeFileSync(temporary, json);
  fs.renameSync(temporary, outputFile);

  const manifest = fs.existsSync(manifestFile)
    ? JSON.parse(fs.readFileSync(manifestFile, "utf8"))
    : { datasets: [] };
  const dataset = {
    id: DATASET_ID,
    title: "WISE WFD 2022 SurfaceWaterBodyLine",
    version: VERSION,
    license: "EEA standard re-use policy / CC BY 4.0",
    priority: 200,
    file: path.basename(outputFile),
    source_url: SERVICE,
    downloaded_at: collection.metadata.downloaded_at,
    sha256: checksum,
    code_fields: ["thematicIdIdentifier", "inspireIdLocalId", "euSurfaceWaterBodyCode", "waterBodyIdentifier"],
    name_fields: ["nameText", "nameTextInternational", "waterBodyName"],
    feature_id_fields: ["inspireIdLocalId", "thematicIdIdentifier", "OBJECTID"]
  };
  manifest.datasets = [...(manifest.datasets || []).filter(item => item.id !== DATASET_ID), dataset];
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Saved ${features.length} official Italian river lines (${checksum.slice(0, 12)}…)`);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
