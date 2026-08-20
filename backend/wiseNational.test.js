import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ITALIAN_REGIONS, normalizeWiseStatus, regionCodesForGeometry } from "./wiseNational.js";

test("WISE ecological and chemical classes remain distinct and use worst status", () => {
  const result = normalizeWiseStatus({
    swEcologicalStatusOrPotentialValue: "2",
    swChemicalStatusValue: "3"
  });
  assert.equal(result.ecological.label, "Buono");
  assert.equal(result.chemical.label, "Non buono");
  assert.equal(result.wfd, "bad");
  assert.equal(result.score, 0.85);
});

test("river geometry can belong to multiple administrative regions", () => {
  const regions = [
    { type: "Feature", properties: { NUTS_ID: "ITI2" }, geometry: { type: "Polygon", coordinates: [[[0,0],[1,0],[1,1],[0,1],[0,0]]] } },
    { type: "Feature", properties: { NUTS_ID: "ITI4" }, geometry: { type: "Polygon", coordinates: [[[1,0],[2,0],[2,1],[1,1],[1,0]]] } }
  ];
  const geometry = { type: "LineString", coordinates: [[0.25, 0.5], [1.75, 0.5]] };
  assert.deepEqual(regionCodesForGeometry(geometry, regions), ["LAZ", "UMB"]);
});

test("versioned national snapshots cover Italy and all 20 regions", () => {
  const status = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "data", "regional", "wise-wfd-2022-it-status.json"), "utf8"));
  const regions = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "data", "regional", "nuts-2024-it-regions.geojson"), "utf8"));
  assert.ok(status.records.length >= 5000);
  assert.ok(status.records.every(record => record.countryCode === "IT" && record.euSurfaceWaterBodyCode));
  assert.equal(ITALIAN_REGIONS.length, 20);
  assert.ok(regions.features.length >= 20);
});
