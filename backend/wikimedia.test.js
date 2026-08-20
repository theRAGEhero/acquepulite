import test from "node:test";
import assert from "node:assert/strict";
import { scoreIncidentCandidate, scoreRiverCandidate } from "./wikimedia.js";

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

test("incident matching rejects an ordinary directly-linked place without event evidence", () => {
  const ordinaryPlace = entity({ label: "Parco del Lambro", description: "parco italiano della Lombardia", type: "Q22698" });
  const result = scoreIncidentCandidate({ name: "Lambro" }, ordinaryPlace, [{ property: "P276", direction: "item_to_river" }]);
  assert.equal(result.incidentEvidence, false);
});

test("incident matching accepts a significant event linked from the river", () => {
  const event = entity({ label: "Evento del 2010", description: "evento ambientale in Italia", type: "Q1190554" });
  const result = scoreIncidentCandidate({ name: "Lambro" }, event, [{ property: "P793", direction: "river_to_item" }]);
  assert.equal(result.incidentEvidence, true);
  assert.ok(result.score >= 80);
  assert.match(result.relation, /significant event/i);
});

test("incident search candidate needs both river and incident evidence", () => {
  const pollution = entity({ label: "Inquinamento del Lambro", description: "contaminazione ambientale del fiume" });
  const result = scoreIncidentCandidate({ name: "Lambro" }, pollution);
  assert.equal(result.incidentEvidence, true);
  assert.ok(result.score >= 70);
});
