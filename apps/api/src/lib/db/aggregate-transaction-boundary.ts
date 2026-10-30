import { getPgErrorCode } from "@/api/lib/pg-error";

import {
  type AggregateTransactionBudget,
  AggregateTransactionTimeoutError,
} from "./aggregate-transaction-budget";

/** Preserve Drizzle's rejection contract while identifying exhausted budgets. */
export const withAggregateTransactionBoundary = async <T>(
  budget: AggregateTransactionBudget,
  run: () => Promise<T>,
): Promise<T> => {
  try {
    return await run();
  } catch (error) {
    if (getPgErrorCode(error) !== "25P04") {
      throw error;
    }
    throw new AggregateTransactionTimeoutError({
      message: `Aggregate transaction exceeded ${budget.reason} budget (${budget.milliseconds} ms)`,
      cause: error,
      budget,
      reason: budget.reason,
    });
  }
};
