import { createSanctionsMatcherPoolCore } from "./matcher-pool-core";
import type { MatcherPoolOptions } from "./matcher-pool-core";
import { reportSanctionsScreeningFailure } from "./screening-failure";

export {
  SANCTIONS_MATCHER_CONFIG,
  isSanctionsMatcherCancelled,
} from "./matcher-pool-core";
export type {
  SanctionsMatcherSession,
  MatcherWorkOutcome,
} from "./matcher-pool-core";

type BoundMatcherPoolOptions = Omit<MatcherPoolOptions, "reportFailure"> & {
  reportFailure?: typeof reportSanctionsScreeningFailure;
};

/** Bind the reusable worker pool to API failure telemetry. */
export const createSanctionsMatcherPool = ({
  reportFailure = reportSanctionsScreeningFailure,
  ...options
}: BoundMatcherPoolOptions = {}) =>
  createSanctionsMatcherPoolCore({ ...options, reportFailure });

// Lazy: no thread starts until an admitted public screening arrives.
export const sharedSanctionsMatcherPool = createSanctionsMatcherPool();
