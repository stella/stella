import { getPgErrorCode, PG_ERROR } from "@/api/lib/pg-error";

import {
  type AggregateTransactionBudget,
  AggregateTransactionTimeoutError,
} from "./aggregate-transaction-budget";

/** Preserve Drizzle's rejection contract while identifying exhausted budgets. */
export const withAggregateTransactionBoundary = async <T>(
  getBudget: () => AggregateTransactionBudget,
  run: () => Promise<T>,
): Promise<T> => {
  try {
    return await run();
  } catch (error) {
    const budget = getBudget();
    if (
      budget.kind !== "aggregate" ||
      getPgErrorCode(error) !== PG_ERROR.TRANSACTION_TIMEOUT
    ) {
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
