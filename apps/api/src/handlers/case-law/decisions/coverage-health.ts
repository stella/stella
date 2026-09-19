import { panic } from "better-result";

import { DAY_IN_MS } from "@stll/time";

/**
 * How current a source is, and how complete it is, as named states.
 *
 * Both are derived here and nowhere else, so the page, the tests and any
 * later reader agree on what "stalled" and "measured" mean. Booleans were
 * the alternative and they cannot carry the distinctions that matter: a
 * court that syncs on time and finds nothing is current, a source switched
 * off on purpose is not the same as one that stopped answering, and a
 * completeness nobody has ever measured is not a completeness of zero.
 */

export const CASE_LAW_COVERAGE_HEALTH = {
  /** Synced within `COVERAGE_CURRENT_WITHIN_MS`. */
  CURRENT: "current",
  /** Last sync is past `current` but within `COVERAGE_DELAYED_WITHIN_MS`. */
  DELAYED: "delayed",
  /** Last sync is older than `COVERAGE_DELAYED_WITHIN_MS`. */
  STALLED: "stalled",
  /** The source is switched off; nothing is expected to arrive. */
  PAUSED: "paused",
  /** The source has never recorded a sync, so there is nothing to judge. */
  UNKNOWN: "unknown",
} as const;

export type CaseLawCoverageHealth =
  (typeof CASE_LAW_COVERAGE_HEALTH)[keyof typeof CASE_LAW_COVERAGE_HEALTH];

/**
 * How recently a source must have synced to read as current.
 *
 * Measured from the sync, never from what the sync found: most courts publish
 * nothing on most days, so "no new decisions" is the ordinary case and using
 * it as the signal would mark every quiet court as broken. Two plain
 * 24-hour days rather than calendar days, so a DST boundary cannot move the
 * threshold.
 */
export const COVERAGE_CURRENT_WITHIN_MS = 2 * DAY_IN_MS;

/** Past `current`, how long a source may lag before it reads as stalled. */
export const COVERAGE_DELAYED_WITHIN_MS = 7 * DAY_IN_MS;

/**
 * How recently a publisher's own total must have been observed for the
 * completeness computed from it to be presented as current. Past this the
 * ratio is still shown, labelled `stale`: an old denominator is a fact worth
 * stating, not a number to quietly present as today's.
 */
export const COVERAGE_REPORTED_TOTAL_FRESH_WITHIN_MS = 30 * DAY_IN_MS;

type SourceHealthRead = {
  /** `case_law_sources.enabled`. */
  enabled: boolean;
  /** `case_law_sources.last_sync_at`; null before the first run. */
  lastSyncAt: Date | null;
  /** The instant the windows are measured back from. */
  now: Date;
};

export const caseLawSourceHealth = ({
  enabled,
  lastSyncAt,
  now,
}: SourceHealthRead): CaseLawCoverageHealth => {
  if (!enabled) {
    return CASE_LAW_COVERAGE_HEALTH.PAUSED;
  }
  if (lastSyncAt === null) {
    return CASE_LAW_COVERAGE_HEALTH.UNKNOWN;
  }
  // A sync stamped ahead of `now` (clock skew between the ingestion host and
  // this one) is negative here and reads as current, which is the honest
  // answer: the source has just run.
  const elapsedMs = now.getTime() - lastSyncAt.getTime();
  if (elapsedMs <= COVERAGE_CURRENT_WITHIN_MS) {
    return CASE_LAW_COVERAGE_HEALTH.CURRENT;
  }
  if (elapsedMs <= COVERAGE_DELAYED_WITHIN_MS) {
    return CASE_LAW_COVERAGE_HEALTH.DELAYED;
  }
  return CASE_LAW_COVERAGE_HEALTH.STALLED;
};

/**
 * How loudly a state speaks for the country it belongs to.
 *
 * `paused` sits below `current` on purpose: a source switched off is a
 * decision someone took, not a fault, so it must not outrank a working
 * sibling. A country whose every source is paused is reported paused by the
 * rule below rather than by this ranking.
 */
const HEALTH_SEVERITY = {
  paused: 0,
  current: 1,
  unknown: 2,
  delayed: 3,
  stalled: 4,
} as const satisfies Record<CaseLawCoverageHealth, number>;

/**
 * One country's health from its sources'.
 *
 * The worst of the sources that are meant to be running, so a single stalled
 * court is visible rather than averaged away. A country with no sources at
 * all, or none still running, reports `unknown` and `paused` respectively:
 * neither is a corpus anyone should read as healthy.
 */
export const caseLawCountryHealth = (
  sources: readonly CaseLawCoverageHealth[],
): CaseLawCoverageHealth => {
  if (sources.length === 0) {
    return CASE_LAW_COVERAGE_HEALTH.UNKNOWN;
  }
  const running = sources.filter(
    (health) => health !== CASE_LAW_COVERAGE_HEALTH.PAUSED,
  );
  if (running.length === 0) {
    return CASE_LAW_COVERAGE_HEALTH.PAUSED;
  }
  let worst = running[0] ?? CASE_LAW_COVERAGE_HEALTH.UNKNOWN;
  for (const health of running) {
    if (HEALTH_SEVERITY[health] > HEALTH_SEVERITY[worst]) {
      worst = health;
    }
  }
  return worst;
};

/**
 * How exact a stored count is.
 *
 * Counting a source's rows is bounded, so a corpus larger than the bound is
 * reported as a floor rather than as a wrong exact number. The discriminator
 * travels with the number so no reader can mistake one for the other.
 */
export type CaseLawStoredCount =
  | { precision: "exact"; decisions: number }
  | { precision: "at-least"; decisions: number };

/** Who stated the publisher's total. */
export const CASE_LAW_TOTAL_REPORTER = {
  /** Read from the publisher's own count endpoint. */
  PUBLISHER: "publisher",
  /** Recorded by hand where the publisher exposes no count. */
  OPERATOR: "operator",
} as const;

export type CaseLawTotalReporter =
  (typeof CASE_LAW_TOTAL_REPORTER)[keyof typeof CASE_LAW_TOTAL_REPORTER];

/** The numbers a completeness is computed from, whatever its freshness. */
type CaseLawCompletenessMeasurement = {
  /**
   * Decisions the corpus holds for this source, including identities the
   * publisher listed whose document has not arrived yet. That population is
   * the one the publisher's own total describes; it is deliberately NOT the
   * searchable count, which excludes those rows.
   */
  stored: CaseLawStoredCount;
  /** What the publisher says it holds. */
  reported: number;
  /** When `reported` was observed. ISO 8601. */
  asOf: string;
  reportedBy: CaseLawTotalReporter;
};

/**
 * Completeness of one source, as a total state.
 *
 * Every source lands in exactly one arm, and an unmeasured source says so
 * rather than leaving a blank: for a reader checking whether a corpus is
 * being kept up, "nobody has measured this" is itself the finding.
 */
export type CaseLawSourceCompleteness =
  | ({ state: "measured" } & CaseLawCompletenessMeasurement)
  | ({ state: "stale" } & CaseLawCompletenessMeasurement)
  /** No total has ever been recorded for this source. */
  | { state: "not-measured-yet" }
  /**
   * A total is recorded, but counting the stored rows did not finish inside
   * its bound. A ratio is withheld rather than guessed.
   */
  | { state: "count-unavailable"; reported: number; asOf: string };

type SourceCompletenessRead = {
  /** The persisted trio; all three are set together or all three are null. */
  reportedTotal: number | null;
  reportedTotalAsOf: Date | null;
  reportedBy: CaseLawTotalReporter | null;
  /** Null when the bounded count did not finish. */
  stored: CaseLawStoredCount | null;
  now: Date;
};

export const caseLawSourceCompleteness = ({
  now,
  reportedBy,
  reportedTotal,
  reportedTotalAsOf,
  stored,
}: SourceCompletenessRead): CaseLawSourceCompleteness => {
  if (
    reportedTotal === null ||
    reportedTotalAsOf === null ||
    reportedBy === null
  ) {
    return { state: "not-measured-yet" };
  }
  const asOf = reportedTotalAsOf.toISOString();
  if (stored === null) {
    return { state: "count-unavailable", reported: reportedTotal, asOf };
  }
  const measurement = {
    stored,
    reported: reportedTotal,
    asOf,
    reportedBy,
  } satisfies CaseLawCompletenessMeasurement;
  const observedMsAgo = now.getTime() - reportedTotalAsOf.getTime();
  return observedMsAgo <= COVERAGE_REPORTED_TOTAL_FRESH_WITHIN_MS
    ? { state: "measured", ...measurement }
    : { state: "stale", ...measurement };
};

/**
 * A country's completeness, kept as counts per state rather than as one
 * percentage.
 *
 * Only the sources that carry both numbers are summed; the rest are counted
 * beside the sum. Folding an unmeasured source into a ratio would make a
 * corpus nobody has checked look as complete as one that has been.
 */
export type CaseLawCountryCompleteness = {
  /** Sources whose totals are summed below. */
  measuredSources: number;
  /** Sum of `stored` over those sources. */
  stored: number;
  /** Sum of `reported` over those sources. */
  reported: number;
  /**
   * True when any summed source's own count hit its bound, so the sum is a
   * floor. Kept distinct from the ratio itself.
   */
  storedPrecision: CaseLawStoredCount["precision"];
  /** Sources whose total is older than the freshness window. */
  staleSources: number;
  /** Sources no total has ever been recorded for. */
  unmeasuredSources: number;
  /** Sources with a total whose stored count could not be read. */
  uncountedSources: number;
};

export const caseLawCountryCompleteness = (
  sources: readonly CaseLawSourceCompleteness[],
): CaseLawCountryCompleteness => {
  // Annotated rather than inferred: the literals would otherwise widen
  // `storedPrecision` to its own literal type and refuse the loop's write.
  const totals: CaseLawCountryCompleteness = {
    measuredSources: 0,
    stored: 0,
    reported: 0,
    storedPrecision: "exact",
    staleSources: 0,
    unmeasuredSources: 0,
    uncountedSources: 0,
  };

  for (const source of sources) {
    switch (source.state) {
      case "measured":
      case "stale": {
        totals.measuredSources += 1;
        totals.stored += source.stored.decisions;
        totals.reported += source.reported;
        if (source.stored.precision === "at-least") {
          totals.storedPrecision = "at-least";
        }
        if (source.state === "stale") {
          totals.staleSources += 1;
        }
        break;
      }
      case "not-measured-yet": {
        totals.unmeasuredSources += 1;
        break;
      }
      case "count-unavailable": {
        totals.uncountedSources += 1;
        break;
      }
      default: {
        source satisfies never;
        return panic("Unhandled case-law source completeness state");
      }
    }
  }

  return totals;
};
