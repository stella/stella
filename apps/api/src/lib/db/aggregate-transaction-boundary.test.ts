import { expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { withAggregateTransactionBoundary } from "./aggregate-transaction-boundary";
import {
  AGGREGATE_TRANSACTION_BUDGETS,
  AggregateTransactionTimeoutError,
} from "./aggregate-transaction-budget";

test.each(
  Object.values(AGGREGATE_TRANSACTION_BUDGETS).filter(
    (budget) => budget.kind !== "dedicated-deadline",
  ),
)(
  "transaction rejection names the exhausted budget ($reason)",
  async (budget) => {
    const cause = { cause: { code: "25P04" } };
    const failure = await rejectionOf(
      withAggregateTransactionBoundary(budget, () => Promise.reject(cause)),
    );
    expect(failure).toBeInstanceOf(AggregateTransactionTimeoutError);
    if (!AggregateTransactionTimeoutError.is(failure)) {
      return;
    }
    expect(failure.cause).toBe(cause);
    expect(failure.budget).toBe(budget);
    expect(failure.reason).toBe(budget.reason);
    expect(failure.message).toContain(`${budget.milliseconds} ms`);
  },
);

test("transaction boundary preserves successful values and unrelated failures", async () => {
  const budget = AGGREGATE_TRANSACTION_BUDGETS.requestPath;
  const value = { status: "committed" };
  expect(
    await withAggregateTransactionBoundary(budget, () =>
      Promise.resolve(value),
    ),
  ).toBe(value);
  for (const cause of [{ code: "57014" }, { cause: { code: "40001" } }, null]) {
    expect(
      await rejectionOf(
        withAggregateTransactionBoundary(budget, () => Promise.reject(cause)),
      ),
    ).toBe(cause);
  }
});
