import test from "node:test";
import assert from "node:assert/strict";
import { scoreRiverCandidate } from "./wikimedia.js";

function entity({ id = "Q1", label, description, country = true, type = "Q4022", coordinate }) {
  const claims = { P31: [{ mainsnak: { datavalue: { value: { id: type } } } }] };
  if (country) claims.P17 = [{ mainsnak: { datavalue: { value: { id: "Q38" } } } }];
  if (coordinate) claims.P625 = [{ mainsnak: { datavalue: { value: coordinate } } }];
  return {
    id,
    labels: { it: { value: label } },
    descriptions: { it: { value: description } },
    claims,
    sitelinks: { itwiki: { title: label } }
  };
}

test("Wikidata river scoring uses the monitoring region to resolve namesakes", () => {
  const river = { name: "Lambro", region: "Lombardia" };
  const lombardy = entity({ label: "Lambro", description: "fiume italiano della Lombardia" });
  const campania = entity({ label: "Lambro", description: "fiume italiano della Campania" });
  assert.ok(scoreRiverCandidate(river, lombardy) > scoreRiverCandidate(river, campania));
});

test("Wikidata non-watercourse namesakes do not receive semantic river points", () => {
  const river = { name: "Lambro", region: "Lombardia" };
  const watercourse = entity({ label: "Lambro", description: "fiume italiano della Lombardia" });
  const fungus = entity({ label: "Lambro", description: "genere di funghi", country: false, type: "Q16521" });
  assert.ok(scoreRiverCandidate(river, watercourse) - scoreRiverCandidate(river, fungus) >= 70);
});

test("Wikidata river scoring rejects a distant same-country namesake", () => {
  const river = {
    name: "Lambro", region: "Lombardia (ARPA)",
    geom: { type: "LineString", coordinates: [[9.54, 45.13], [9.30, 45.45]] }
  };
  const local = entity({
    label: "Lambro", description: "fiume italiano, affluente del Po",
    coordinate: { longitude: 9.546, latitude: 45.1355 }
  });
  const distant = entity({
    label: "Lambro", description: "fiume italiano della Campania",
    coordinate: { longitude: 15.25, latitude: 40.25 }
  });
  assert.ok(scoreRiverCandidate(river, local) - scoreRiverCandidate(river, distant) >= 70);
});
