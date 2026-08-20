import test from "node:test";
import assert from "node:assert/strict";
import { assembleConnectedWays, splitLongSourceSteps } from "./riverGeometry.js";
import { combineLineGeometries, resolveOfficialGeometry, simplifyGeometry, snapPointToGeometry, sliceLineBetweenSnaps } from "./hydrography.js";

test("OSM ways connect only through identical endpoint node IDs", () => {
  const chains = assembleConnectedWays([
    { id: 1, order: 0, nodeIds: [10, 11], coords: [[45, 9], [45.1, 9.1]] },
    { id: 2, order: 1, nodeIds: [11, 12], coords: [[45.1, 9.1], [45.2, 9.2]] },
    // Geographically close, but not the same OSM node: must remain separate.
    { id: 3, order: 2, nodeIds: [99, 100], coords: [[45.200001, 9.200001], [46, 10]] }
  ]);
  assert.equal(chains.length, 2);
  const connected = chains.find(chain => chain.wayIds.includes(1));
  assert.deepEqual(connected.wayIds, [1, 2]);
  assert.equal(connected.coords.length, 3);
});

test("station snapping returns distance and position along the correct line", () => {
  const geometry = {
    type: "MultiLineString",
    coordinates: [
      [[9, 45], [10, 45]],
      [[9, 46], [10, 46], [11, 46]]
    ]
  };
  const snap = snapPointToGeometry([10.2, 46.01], geometry);
  assert.equal(snap.line_index, 1);
  assert.equal(snap.segment_index, 1);
  assert.ok(snap.distance_m < 1200);
});

test("long source chords become gaps instead of highlighted straight lines", () => {
  const result = splitLongSourceSteps([
    [45, 9], [45.005, 9.005], [46, 10], [46.005, 10.005]
  ]);
  assert.equal(result.gaps, 1);
  assert.equal(result.lines.length, 2);
  assert.deepEqual(result.lines[0], [[45, 9], [45.005, 9.005]]);
});

test("monitored reach slicing follows all intervening river vertices", () => {
  const line = [[9, 45], [9.5, 45.2], [10, 45], [10.5, 44.8]];
  const from = snapPointToGeometry([9.25, 45.1], { type: "LineString", coordinates: line });
  const to = snapPointToGeometry([10.25, 44.9], { type: "LineString", coordinates: line });
  const reach = sliceLineBetweenSnaps(line, from, to);
  assert.deepEqual(reach.slice(1, -1), [[9.5, 45.2], [10, 45]]);
});

test("official disconnected water bodies stay MultiLineString", () => {
  const geometry = combineLineGeometries([
    { type: "LineString", coordinates: [[9, 45], [10, 45]] },
    { type: "LineString", coordinates: [[11, 45], [12, 45]] }
  ]);
  assert.equal(geometry.type, "MultiLineString");
  assert.equal(geometry.coordinates.length, 2);
});

test("display simplification preserves endpoints and river bends", () => {
  const geometry = simplifyGeometry({
    type: "LineString",
    coordinates: [[9, 45], [9.00001, 45.00001], [9.5, 45.5], [10, 45], [10.00001, 45.00001]]
  }, 0.00025);
  assert.deepEqual(geometry.coordinates[0], [9, 45]);
  assert.deepEqual(geometry.coordinates.at(-1), [10.00001, 45.00001]);
  assert.ok(geometry.coordinates.some(point => point[0] === 9.5 && point[1] === 45.5));
  assert.ok(geometry.coordinates.length < 5);
});

test("a unique exact official name is reviewable; ambiguous names are not guessed", () => {
  const record = {
    feature: { geometry: { type: "LineString", coordinates: [[9, 45], [10, 45]] } },
    dataset: { id: "wise", title: "WISE", priority: 200, version: "2022" },
    featureId: "official-1"
  };
  const catalog = { byCode: new Map(), byName: new Map([["ARNOARETINO", [record]]]) };
  const river = { name: "Arno", stretches: [{ name: "Fiume Arno Aretino", water_body_code: "MAS-102" }] };
  const resolved = resolveOfficialGeometry(catalog, river);
  assert.equal(resolved.geometry_quality, "official");
  assert.equal(river.stretches[0].geometry_match, "exact-name");
  assert.equal(river.stretches[0].requires_review, true);

  const ambiguous = { byCode: new Map(), byName: new Map([["ARNOARETINO", [record, record]]]) };
  assert.equal(resolveOfficialGeometry(ambiguous, {
    name: "No river match", stretches: [{ name: "Arno Aretino", water_body_code: "MAS-102" }]
  }), null);
});
