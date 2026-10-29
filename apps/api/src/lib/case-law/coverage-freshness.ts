/** How often the scheduler recomputes the stored case-law coverage answer. */
export const CASE_LAW_COVERAGE_REFRESH_INTERVAL_MS = 5 * 60_000;

/**
 * How old a stored answer may be and still read as current: one or two late
 * runs are ordinary scheduling slack, a third means refreshes are not landing.
 */
const CASE_LAW_COVERAGE_CURRENT_WITHIN_MS =
  3 * CASE_LAW_COVERAGE_REFRESH_INTERVAL_MS;

export const CASE_LAW_COVERAGE_FRESHNESS = {
  /** Recent, and computed under the redistribution policy now in force. */
  CURRENT: "current",
  /** Older than the refresh cadence allows, or computed under an earlier policy. */
  REFRESH_PENDING: "refresh_pending",
} as const;

export type CaseLawCoverageFreshnessStatus =
  (typeof CASE_LAW_COVERAGE_FRESHNESS)[keyof typeof CASE_LAW_COVERAGE_FRESHNESS];

/** How old the served coverage figures are, as a reader may act on it. */
export type CaseLawCoverageFreshness = {
  status: CaseLawCoverageFreshnessStatus;
  /** Whole seconds since the figures were computed; never negative. */
  ageSeconds: number;
};

type FreshnessInput = {
  generatedAt: Date;
  now: Date;
  /** Whether the stored answer was computed under the current policy. */
  policyCurrent: boolean;
};

export const caseLawCoverageFreshness = ({
  generatedAt,
  now,
  policyCurrent,
}: FreshnessInput): CaseLawCoverageFreshness => {
  // A clock behind the writer's reads as zero age, not as a negative one.
  const ageMs = Math.max(0, now.getTime() - generatedAt.getTime());
  return {
    status:
      policyCurrent && ageMs <= CASE_LAW_COVERAGE_CURRENT_WITHIN_MS
        ? CASE_LAW_COVERAGE_FRESHNESS.CURRENT
        : CASE_LAW_COVERAGE_FRESHNESS.REFRESH_PENDING,
    ageSeconds: Math.floor(ageMs / 1000),
  };
};
