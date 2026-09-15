// Screening thresholds used to score measured parameters.
//
// PROVENANCE WARNING: these values are not yet traced to a legal instrument.
// They appear to mix drinking-water limits, bathing-water class boundaries and
// WFD environmental quality standards on a single scale, and the UI presents
// them only as "screening references", never as a compliance ruling.
// They are scheduled to be replaced by a fully cited thresholds table
// (value + basis + legal_reference + source_url) — see plan workstream A1.
//
// This file previously also held hand-traced river geometries and a seeded
// pseudo-random measurement generator. Both were unused and contradicted the
// project rule that no fabricated data exists anywhere in the codebase; they
// were deleted rather than left available to be wired up by mistake.

export const parameters = [
  { code: "NO3", name: "Nitrates", unit: "mg/L", legal_limit: 10 },
  { code: "PO4", name: "Phosphates", unit: "mg/L", legal_limit: 0.2 },
  { code: "EC", name: "Escherichia coli", unit: "MPN/100mL", legal_limit: 500 },
  { code: "PB", name: "Lead", unit: "µg/L", legal_limit: 10 },
  { code: "DO", name: "Dissolved Oxygen", unit: "mg/L", legal_limit: null }
];
