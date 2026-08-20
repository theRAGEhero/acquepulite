import test from "node:test";
import assert from "node:assert/strict";
import { scoreRiverCandidate } from "./wikimedia.js";

function entity({ id = "Q1", label, description, country = true, type = "Q4022" }) {
  const claims = { P31: [{ mainsnak: { datavalue: { value: { id: type } } } }] };
  if (country) claims.P17 = [{ mainsnak: { datavalue: { value: { id: "Q38" } } } }];
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
