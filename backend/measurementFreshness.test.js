import test from "node:test";
import assert from "node:assert/strict";
import { measurementsAreCurrent, MEASUREMENT_FRESHNESS_YEARS } from "./measurementFreshness.js";

// The defect this guards against: the ARPA Lombardia Socrata series stops in
// December 2016 and was labelled "Latest available agency measurements", so
// ten-year-old samples coloured 129 river reaches as current pollution.
const NOW = Date.parse("2026-09-16T00:00:00Z");

test("decade-old measurements do not colour the map", () => {
  assert.equal(measurementsAreCurrent("2016-12-06", NOW), false);
  assert.equal(measurementsAreCurrent("2016-12-29", NOW), false);
});

test("recent measurements still colour the map", () => {
  assert.equal(measurementsAreCurrent("2026-06-01", NOW), true);
  assert.equal(measurementsAreCurrent("2025-01-15", NOW), true);
});

test("the freshness boundary is the configured number of years", () => {
  const withinDays = (days) =>
    new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const justInside = withinDays(MEASUREMENT_FRESHNESS_YEARS * 365.25 - 2);
  const justOutside = withinDays(MEASUREMENT_FRESHNESS_YEARS * 365.25 + 2);
  assert.equal(measurementsAreCurrent(justInside, NOW), true);
  assert.equal(measurementsAreCurrent(justOutside, NOW), false);
});

test("a missing or unparseable date is never treated as current", () => {
  for (const value of [null, undefined, "", "non una data", "0000-00-00"]) {
    assert.equal(measurementsAreCurrent(value, NOW), false,
      `${String(value)} must not count as current`);
  }
});
