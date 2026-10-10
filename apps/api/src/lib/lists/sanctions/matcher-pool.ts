import { createSanctionsMatcherPoolCore } from "./matcher-pool-core";
import type { MatcherPoolOptions } from "./matcher-pool-core";
import {
  reportSanctionsMatcherFailure,
  reportSanctionsScreeningFailure,
} from "./screening-failure";

export {
  SANCTIONS_MATCHER_CONFIG,
  isSanctionsMatcherCancelled,
} from "./matcher-pool-core";
export type { MatcherWorkOutcome } from "./matcher-pool-core";

type BoundMatcherPoolOptions = Omit<MatcherPoolOptions, "reportFailure"> & {
  reportFailure?: typeof reportSanctionsMatcherFailure;
};

/** Bind the reusable worker pool to API failure telemetry. */
export const createSanctionsMatcherPool = ({
  reportFailure = reportSanctionsMatcherFailure,
  reportUnownedFailure = reportSanctionsScreeningFailure,
  ...options
}: BoundMatcherPoolOptions = {}) =>
  createSanctionsMatcherPoolCore({
    ...options,
    reportFailure,
    reportUnownedFailure,
  });

// Lazy: no thread starts until an admitted public screening arrives.
export const sharedSanctionsMatcherPool = createSanctionsMatcherPool();
