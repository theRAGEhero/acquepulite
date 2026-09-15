// Single source of truth for Water Framework Directive status classification.
//
// Before this module each adapter carried its own copy of the score table and
// its own score→class function. They had drifted apart in three ways that all
// changed what users saw on the map:
//
//   1. arpaPiemonte.js and arpaVeneto.js used an inline ternary with no "high"
//      branch, so the best ecological class was unreachable in those regions —
//      zero of 442 Piemonte and 355 Veneto rivers could ever be "high", while
//      FVG and Lazio produced it normally.
//   2. That same inline ternary had no guard for a non-finite score. A water
//      body with no classification fell through every comparison and came out
//      "good", i.e. missing data was rendered as favourable — the worst
//      possible direction of error for an environmental platform.
//   3. arpatToscana.js used different score values (Sufficiente 0.45,
//      Scarso 0.7, chemical "Non buono" 0.75) than everyone else, so a water
//      body failing chemical status was "poor" in Toscana and "bad" in every
//      other region.
//
// Classification follows the one-out-all-out principle: the overall class is
// the worst of the contributing elements.
//   - Directive 2000/60/EC (WFD), Annex V
//   - D.Lgs. 152/2006 and D.M. 260/2010 for the Italian implementation
//
// Scores are an internal 0..1 severity used for map colouring only; the class
// label is the authoritative value. The mapping round-trips: every class maps
// to a score that maps back to the same class.

export const ECOLOGICAL_SCORE = Object.freeze({
  Elevato: 0.05,
  Buono: 0.2,
  Sufficiente: 0.5,
  Scarso: 0.75,
  Cattivo: 0.95
});

export const CHEMICAL_SCORE = Object.freeze({
  Buono: 0.2,
  "Non buono": 0.85
});

// WISE reports classes as numeric codes; these are the EEA code lists.
export const WISE_ECOLOGICAL_CODE = Object.freeze({
  "1": "Elevato", "2": "Buono", "3": "Sufficiente", "4": "Scarso", "5": "Cattivo"
});
export const WISE_CHEMICAL_CODE = Object.freeze({ "2": "Buono", "3": "Non buono" });

const ECOLOGICAL_PATTERNS = [
  [/elevat/i, "Elevato"],
  [/sufficient/i, "Sufficiente"],
  [/scars/i, "Scarso"],
  [/cattiv/i, "Cattivo"],
  // "buono" is checked last: "non buono" must not match it first.
  [/buon/i, "Buono"]
];

/**
 * Normalise a free-text ecological class to its canonical Italian label.
 * Returns null for anything unrecognised — never a default class.
 */
export function normalizeEcologicalLabel(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  if (/^non\s*buono$/i.test(text)) return null; // chemical vocabulary, not ecological
  for (const [pattern, label] of ECOLOGICAL_PATTERNS) {
    if (pattern.test(text)) return label;
  }
  return null;
}

/**
 * Normalise a free-text chemical class. Chemical status is binary under the
 * WFD: it either achieves good status or it does not.
 */
export function normalizeChemicalLabel(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  if (/^non\s*buono$/i.test(text)) return "Non buono";
  if (/^buono$/i.test(text)) return "Buono";
  return null;
}

export function ecologicalScore(label) {
  const normalized = normalizeEcologicalLabel(label);
  return normalized ? ECOLOGICAL_SCORE[normalized] : null;
}

export function chemicalScore(label) {
  const normalized = normalizeChemicalLabel(label);
  return normalized ? CHEMICAL_SCORE[normalized] : null;
}

/**
 * The constraint chemical status places on the OVERALL class.
 *
 * Chemical status is binary under the WFD: "Buono" means every environmental
 * quality standard is met, which is full compliance and the best chemical class
 * there is. It therefore cannot make a water body worse than its ecological
 * class — only chemical failure downgrades.
 *
 * Feeding CHEMICAL_SCORE.Buono (0.2) into one-out-all-out capped every pristine
 * river at "good": Piemonte has 13 water bodies classified ecologically
 * "Elevato", and all 13 were reported as "good" purely because their chemistry
 * was compliant. Use this function — not CHEMICAL_SCORE — when combining.
 */
export function chemicalConstraint(label) {
  return normalizeChemicalLabel(label) === "Non buono" ? CHEMICAL_SCORE["Non buono"] : null;
}

/**
 * Convert an internal severity score to a WFD class key.
 *
 * Returns null — never a class — when the score is not a finite number. An
 * unclassified water body must be reported as unclassified.
 */
export function scoreToWfd(score) {
  if (!Number.isFinite(score)) return null;
  if (score >= 0.85) return "bad";
  if (score >= 0.65) return "poor";
  if (score >= 0.4) return "moderate";
  if (score >= 0.1) return "good";
  return "high";
}

/**
 * One-out-all-out: the overall severity is the worst contributing element.
 * Returns null when no element carries a usable score.
 */
export function combineScores(scores) {
  const usable = (scores || []).filter(Number.isFinite);
  return usable.length ? Math.max(...usable) : null;
}

export const WFD_RANK = Object.freeze({ high: 0, good: 1, moderate: 2, poor: 3, bad: 4 });

/**
 * Worst (highest-rank) class of a list, ignoring unclassified entries.
 * Returns null when nothing in the list is classified.
 */
export function worstWfd(statuses) {
  const known = (statuses || []).filter(status => status in WFD_RANK);
  if (!known.length) return null;
  return known.reduce((worst, status) => (WFD_RANK[status] > WFD_RANK[worst] ? status : worst));
}

/**
 * Classify one water body from its ecological and chemical labels.
 *
 * `determined_by` names the element that set the overall class, which the
 * one-out-all-out rule requires to be reportable.
 */
export function classifyWaterBody({ ecological, chemical, indicator = null } = {}) {
  const ecologicalLabel = normalizeEcologicalLabel(ecological);
  const chemicalLabel = normalizeChemicalLabel(chemical);
  const ecoScore = ecologicalLabel ? ECOLOGICAL_SCORE[ecologicalLabel] : null;
  const chemScore = chemicalLabel ? CHEMICAL_SCORE[chemicalLabel] : null;
  // Compliant chemistry constrains nothing; only failure downgrades.
  const chemLimit = chemicalConstraint(chemicalLabel);
  const score = combineScores([ecoScore, chemLimit]);

  let determinedBy = null;
  if (score != null) {
    if (chemLimit === score && ecoScore !== score) determinedBy = "chemical";
    else if (ecoScore === score && chemLimit !== score) determinedBy = indicator || "ecological";
    else determinedBy = "both";
  }

  return {
    ecological: ecologicalLabel,
    chemical: chemicalLabel,
    ecological_score: ecoScore,
    chemical_score: chemScore,
    score,
    wfd: scoreToWfd(score),
    determined_by: determinedBy
  };
}
