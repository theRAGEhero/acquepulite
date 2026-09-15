import test from "node:test";
import assert from "node:assert/strict";
import {
  scoreToWfd, classifyWaterBody, combineScores, worstWfd,
  normalizeEcologicalLabel, normalizeChemicalLabel, chemicalConstraint,
  ECOLOGICAL_SCORE, CHEMICAL_SCORE
} from "./wfdClassification.js";

// The regression this module exists to prevent: an unclassified water body used
// to fall through an inline ternary and come out "good" in Piemonte and Veneto.
test("an unclassified score is never a class", () => {
  for (const value of [null, undefined, NaN, "", "buono", Infinity, -Infinity]) {
    assert.equal(scoreToWfd(value), null, `${String(value)} must not produce a class`);
  }
});

test("classifying with no usable input yields null, not a favourable class", () => {
  for (const input of [{}, { ecological: null, chemical: null }, { ecological: "???" }]) {
    const result = classifyWaterBody(input);
    assert.equal(result.wfd, null);
    assert.equal(result.score, null);
    assert.notEqual(result.wfd, "good");
  }
});

// The second regression: "high" was unreachable where the branch was missing.
test("the best ecological class is reachable", () => {
  assert.equal(classifyWaterBody({ ecological: "Elevato" }).wfd, "high");
  assert.equal(scoreToWfd(ECOLOGICAL_SCORE.Elevato), "high");
});

test("every class round-trips through its score", () => {
  const expected = {
    Elevato: "high", Buono: "good", Sufficiente: "moderate",
    Scarso: "poor", Cattivo: "bad"
  };
  for (const [label, wfd] of Object.entries(expected)) {
    assert.equal(scoreToWfd(ECOLOGICAL_SCORE[label]), wfd, `${label} must map to ${wfd}`);
    assert.equal(classifyWaterBody({ ecological: label }).wfd, wfd);
  }
});

// The third regression: Toscana scored "Non buono" at 0.75 ("poor") while every
// other region scored it 0.85 ("bad").
test("failing chemical status is 'bad' everywhere", () => {
  assert.equal(CHEMICAL_SCORE["Non buono"], 0.85);
  assert.equal(classifyWaterBody({ chemical: "Non buono" }).wfd, "bad");
  assert.equal(classifyWaterBody({ ecological: "Buono", chemical: "Non buono" }).wfd, "bad");
});

test("one-out-all-out takes the worst element", () => {
  const result = classifyWaterBody({ ecological: "Elevato", chemical: "Non buono" });
  assert.equal(result.wfd, "bad");
  assert.equal(result.determined_by, "chemical");

  const eco = classifyWaterBody({ ecological: "Cattivo", chemical: "Buono" });
  assert.equal(eco.wfd, "bad");
  assert.equal(eco.determined_by, "ecological");
});

// Fourth regression: compliant chemistry was fed into one-out-all-out at 0.2,
// capping every pristine river at "good". Piemonte has 13 water bodies with
// ecological status "Elevato" and all 13 were reported as "good".
test("compliant chemical status does not downgrade the ecological class", () => {
  assert.equal(chemicalConstraint("Buono"), null);
  assert.equal(chemicalConstraint("Non buono"), 0.85);

  const pristine = classifyWaterBody({ ecological: "Elevato", chemical: "Buono" });
  assert.equal(pristine.wfd, "high", "Elevato + compliant chemistry must stay high");

  const good = classifyWaterBody({ ecological: "Buono", chemical: "Buono" });
  assert.equal(good.wfd, "good");
});

test("chemical failure downgrades any ecological class to bad", () => {
  for (const ecological of ["Elevato", "Buono", "Sufficiente", "Scarso", "Cattivo"]) {
    const result = classifyWaterBody({ ecological, chemical: "Non buono" });
    assert.equal(result.wfd, "bad", `${ecological} + chemical failure must be bad`);
  }
});

test("knowing only that chemistry is compliant leaves the body unclassified", () => {
  // Compliance with chemical EQS says nothing about ecological class; reporting
  // such a body as "good" would invent a classification that was never made.
  const result = classifyWaterBody({ ecological: null, chemical: "Buono" });
  assert.equal(result.wfd, null);
  assert.equal(result.chemical, "Buono", "the chemical fact itself is still reported");
});

test("combineScores ignores unusable values and returns null when empty", () => {
  assert.equal(combineScores([0.2, null, NaN, 0.75]), 0.75);
  assert.equal(combineScores([null, undefined, NaN]), null);
  assert.equal(combineScores([]), null);
});

test("label normalisation does not confuse 'Non buono' with 'Buono'", () => {
  assert.equal(normalizeChemicalLabel("Non buono"), "Non buono");
  assert.equal(normalizeChemicalLabel("non  buono"), "Non buono");
  assert.equal(normalizeChemicalLabel("Buono"), "Buono");
  // "Non buono" belongs to the chemical vocabulary, not the ecological one.
  assert.equal(normalizeEcologicalLabel("Non buono"), null);
  assert.equal(normalizeEcologicalLabel("BUONO"), "Buono");
  assert.equal(normalizeEcologicalLabel("elevato *"), "Elevato");
  assert.equal(normalizeEcologicalLabel("non classificato"), null);
});

test("worstWfd ignores unclassified entries", () => {
  assert.equal(worstWfd(["good", "moderate", "bad"]), "bad");
  assert.equal(worstWfd(["high", "good"]), "good");
  assert.equal(worstWfd([null, undefined, "x"]), null);
  assert.equal(worstWfd([]), null);
});
