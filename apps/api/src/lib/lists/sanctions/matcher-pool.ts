import { detached } from "@/api/lib/analytics/capture";

import { createSanctionsMatcherPoolCore } from "./matcher-pool-core";
import type { DetachWork, MatcherPoolOptions } from "./matcher-pool-core";
import {
  reportSanctionsMatcherFailure,
  reportSanctionsScreeningFailure,
} from "./screening-failure";

export {
  SANCTIONS_MATCHER_CONFIG,
  SANCTIONS_MATCHER_REPLY_GRACE_MS,
  isSanctionsMatcherCancelled,
} from "./matcher-pool-core";
export type { MatcherWorkOutcome } from "./matcher-pool-core";

type BoundMatcherPoolOptions = Omit<
  MatcherPoolOptions,
  "reportFailure" | "detach"
> & {
  reportFailure?: typeof reportSanctionsMatcherFailure;
  detach?: DetachWork;
};

/** Bind the reusable worker pool to API failure telemetry. */
export const createSanctionsMatcherPool = ({
  reportFailure = reportSanctionsMatcherFailure,
  reportUnownedFailure = reportSanctionsScreeningFailure,
  detach = detached,
  ...options
}: BoundMatcherPoolOptions = {}) =>
  createSanctionsMatcherPoolCore({
    ...options,
    reportFailure,
    reportUnownedFailure,
    detach,
  });

// Lazy: no thread starts until an admitted public screening arrives.
export const sharedSanctionsMatcherPool = createSanctionsMatcherPool();
