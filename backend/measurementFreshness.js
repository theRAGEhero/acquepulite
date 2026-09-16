// How old a laboratory measurement may be before it stops colouring the map.
//
// Water quality in Italy is periodic laboratory sampling, not telemetry, so a
// measurement is always somewhat old — but there is a difference between "last
// season" and "last decade". The ARPA Lombardia Socrata series this project
// reads (dati.lombardia.it/resource/ixjj-e763) covers 2016 and was last updated
// in December 2017; the whole ARPA Lombardia analytical family stopped there.
// Those values were labelled "Latest available agency measurements" and painted
// 129 river reaches as current pollution.
//
// Stale values are not deleted: they stay in the river panel, dated, as
// historical record. They simply stop driving a colour that implies "now".

export const MEASUREMENT_FRESHNESS_YEARS = 3;

const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;

/**
 * True when a sampling date is recent enough to represent current conditions.
 * A missing or unparseable date is never current: absence of a date is not
 * evidence of freshness.
 */
export function measurementsAreCurrent(latestSample, now = Date.now(),
                                       maxAgeYears = MEASUREMENT_FRESHNESS_YEARS) {
  if (!latestSample) return false;
  const sampled = Date.parse(latestSample);
  if (!Number.isFinite(sampled)) return false;
  return (now - sampled) / YEAR_MS <= maxAgeYears;
}

/** Latest sampling timestamp across every parameter of a station, or null. */
export function latestSampleDate(byParamMap) {
  let latest = null;
  for (const values of (byParamMap?.values?.() ?? [])) {
    for (const { timestamp } of values) {
      if (timestamp && (latest === null || timestamp > latest)) latest = timestamp;
    }
  }
  return latest;
}

/** Human-readable sampling period derived from the data, never hardcoded. */
export function describeMeasurementPeriod({ first, last }) {
  if (!first || !last) return "Periodo di campionamento non dichiarato dalla fonte";
  const from = first.slice(0, 4);
  const to = last.slice(0, 4);
  return `Campionamenti ${from === to ? from : `${from}–${to}`} (ultimo: ${last})`;
}
