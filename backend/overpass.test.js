import test from "node:test";
import assert from "node:assert/strict";
import { distanceToRiverMeters } from "./overpass.js";

test("facility corridor distance follows the river segment instead of its bounding box", () => {
  const river = { type: "LineString", coordinates: [[9, 45], [10, 45]] };
  const besideRiver = distanceToRiverMeters(45.01, 9.5, river);
  const insideBoundingAreaButFar = distanceToRiverMeters(45.5, 9.5, river);
  assert.ok(besideRiver > 1000 && besideRiver < 1200);
  assert.ok(insideBoundingAreaButFar > 54000);
});

test("facility corridor distance supports disconnected official river lines", () => {
  const river = {
    type: "MultiLineString",
    coordinates: [[[9, 45], [9.2, 45]], [[10, 46], [10.2, 46]]]
  };
  assert.ok(distanceToRiverMeters(46.001, 10.1, river) < 150);
});
