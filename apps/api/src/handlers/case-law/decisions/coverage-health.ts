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
  DISABLED: "disabled",
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
    return CASE_LAW_COVERAGE_HEALTH.DISABLED;
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
 * `disabled` sits below `current` on purpose: a source switched off is a
 * decision someone took, not a fault, so it must not outrank a working
 * sibling. A country whose every source is switched off is reported `disabled` by the
 * rule below rather than by this ranking.
 */
const HEALTH_SEVERITY = {
  disabled: 0,
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
 * all, or none still running, reports `unknown` and `disabled` respectively:
 * neither is a corpus anyone should read as healthy.
 */
export const caseLawCountryHealth = (
  sources: readonly CaseLawCoverageHealth[],
): CaseLawCoverageHealth => {
  if (sources.length === 0) {
    return CASE_LAW_COVERAGE_HEALTH.UNKNOWN;
  }
  const running = sources.filter(
    (health) => health !== CASE_LAW_COVERAGE_HEALTH.DISABLED,
  );
  if (running.length === 0) {
    return CASE_LAW_COVERAGE_HEALTH.DISABLED;
  }
  let worst = running[0] ?? CASE_LAW_COVERAGE_HEALTH.UNKNOWN;
  for (const health of running) {
    if (HEALTH_SEVERITY[health] > HEALTH_SEVERITY[worst]) {
      worst = health;
    }
  }
  return worst;
};

/** Who stated the publisher's total. */
export const CASE_LAW_TOTAL_REPORTER = {
  /** Read from the publisher's own count endpoint. */
  PUBLISHER: "publisher",
  /** Recorded by hand where the publisher exposes no count. */
  OPERATOR: "operator",
} as const;

export type CaseLawTotalReporter =
  (typeof CASE_LAW_TOTAL_REPORTER)[keyof typeof CASE_LAW_TOTAL_REPORTER];

/**
 * The numbers a completeness is computed from, and when each was observed.
 *
 * Both as-of instants travel with the pair because the two are observed
 * independently and can be far apart: the corpus is counted every few hours on
 * the ingestion side, the publisher's total whenever its count endpoint is
 * polled. A ratio whose halves were observed months apart is still worth
 * showing, but not without saying so.
 */
type CaseLawCompletenessMeasurement = {
  /**
   * Decisions the corpus holds for this source, including identities the
   * publisher listed whose document has not arrived yet. That population is
   * the one the publisher's own total describes; it is deliberately NOT the
   * searchable count, which excludes those rows.
   */
  stored: number;
  /** When the corpus was last counted for this source. ISO 8601. */
  storedAsOf: string;
  /** What the publisher says it holds. */
  reported: number;
  /** When `reported` was observed. ISO 8601. */
  reportedAsOf: string;
  reportedBy: CaseLawTotalReporter;
};

/**
 * Completeness of one source, as a total state.
 *
 * Two independent things can be unknown and they are kept apart: nobody has
 * asked the publisher what it holds, and nobody has counted what we hold. A
 * reader checking whether a corpus is being kept up needs to know which,
 * because they are different jobs to go and do.
 */
export type CaseLawSourceCompleteness =
  | ({ state: "measured" } & CaseLawCompletenessMeasurement)
  /** The publisher's total is older than the freshness window. */
  | ({ state: "stale" } & CaseLawCompletenessMeasurement)
  /** No publisher total has ever been recorded for this source. */
  | { state: "not-measured-yet" }
  /** A publisher total exists, but the corpus has never been counted. */
  | { state: "not-counted-yet" };

type SourceCompletenessRead = {
  /** The persisted trio; all three are set together or all three are null. */
  reportedTotal: number | null;
  reportedTotalAsOf: Date | null;
  reportedBy: CaseLawTotalReporter | null;
  /** The persisted pair; both set together or both null. */
  storedTotal: number | null;
  storedTotalAsOf: Date | null;
  now: Date;
};

export const caseLawSourceCompleteness = ({
  now,
  reportedBy,
  reportedTotal,
  reportedTotalAsOf,
  storedTotal,
  storedTotalAsOf,
}: SourceCompletenessRead): CaseLawSourceCompleteness => {
  if (
    reportedTotal === null ||
    reportedTotalAsOf === null ||
    reportedBy === null
  ) {
    return { state: "not-measured-yet" };
  }
  if (storedTotal === null || storedTotalAsOf === null) {
    return { state: "not-counted-yet" };
  }
  const measurement = {
    stored: storedTotal,
    storedAsOf: storedTotalAsOf.toISOString(),
    reported: reportedTotal,
    reportedAsOf: reportedTotalAsOf.toISOString(),
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
   * The OLDEST count among the summed sources, never the newest: a sum is
   * only as current as its stalest part. Null when nothing was summed.
   */
  storedAsOf: string | null;
  /** Sources whose publisher total is older than the freshness window. */
  staleSources: number;
  /** Sources no publisher total has ever been recorded for. */
  notMeasuredSources: number;
  /** Sources with a publisher total whose corpus has never been counted. */
  notCountedSources: number;
};

export const caseLawCountryCompleteness = (
  sources: readonly CaseLawSourceCompleteness[],
): CaseLawCountryCompleteness => {
  const totals: CaseLawCountryCompleteness = {
    measuredSources: 0,
    stored: 0,
    reported: 0,
    storedAsOf: null,
    staleSources: 0,
    notMeasuredSources: 0,
    notCountedSources: 0,
  };

  for (const source of sources) {
    switch (source.state) {
      case "measured":
      case "stale": {
        totals.measuredSources += 1;
        totals.stored += source.stored;
        totals.reported += source.reported;
        // ISO 8601 UTC instants compare correctly as strings.
        if (
          totals.storedAsOf === null ||
          source.storedAsOf < totals.storedAsOf
        ) {
          totals.storedAsOf = source.storedAsOf;
        }
        if (source.state === "stale") {
          totals.staleSources += 1;
        }
        break;
      }
      case "not-measured-yet": {
        totals.notMeasuredSources += 1;
        break;
      }
      case "not-counted-yet": {
        totals.notCountedSources += 1;
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
