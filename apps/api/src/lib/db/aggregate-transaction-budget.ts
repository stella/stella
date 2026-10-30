import { TaggedError } from "better-result";

import type { DEFAULT_LOCK_RETRY_CONFIG } from "../../db/lock-retry-ladder";

/**
 * Transaction budgets are capped by the two-minute online-DDL lock retry
 * budget. Reasons live beside the values so adding a budget requires an
 * explicit operational decision.
 */
export const AGGREGATE_TRANSACTION_BUDGETS = {
  requestPath: { milliseconds: 5000, reason: "interactive request-path work" },
  backgroundBatch: { milliseconds: 30_000, reason: "bounded worker batch" },
  corpusRefresh: {
    milliseconds: 90_000,
    reason: "bounded public-corpus refresh",
  },
  migrationCeiling: {
    milliseconds: 120_000,
    reason: "online-DDL lock retry ceiling",
  },
} as const satisfies Record<
  string,
  { milliseconds: 5000 | 30_000 | 90_000 | 120_000; reason: string }
> & {
  migrationCeiling: {
    milliseconds: typeof DEFAULT_LOCK_RETRY_CONFIG.budgetMs;
    reason: string;
  };
};

export type AggregateTransactionBudget =
  (typeof AGGREGATE_TRANSACTION_BUDGETS)[keyof typeof AGGREGATE_TRANSACTION_BUDGETS];

export class AggregateTransactionTimeoutError extends TaggedError(
  "AggregateTransactionTimeoutError",
)<{
  message: string;
  cause: unknown;
  budget: AggregateTransactionBudget;
  reason: string;
}> {}
