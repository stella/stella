import { TaggedError } from "better-result";
import { expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { PG_ERROR } from "@/api/lib/pg-error";

import { withAggregateTransactionBoundary } from "./aggregate-transaction-boundary";
import {
  AGGREGATE_TRANSACTION_BUDGETS,
  AggregateTransactionTimeoutError,
} from "./aggregate-transaction-budget";

class TransactionBoundaryFixtureError extends TaggedError(
  "TransactionBoundaryFixtureError",
)<{
  message: string;
  cause: unknown;
}> {}

test.each(
  Object.values(AGGREGATE_TRANSACTION_BUDGETS).filter(
    (budget) => budget.kind === "uncapped-pending-measurement",
  ),
)(
  "an uncapped owner preserves database timeout errors ($entryPoint)",
  async (budget) => {
    const cause = new TransactionBoundaryFixtureError({
      message: "Transaction expired without an aggregate deadline",
      cause: { code: PG_ERROR.TRANSACTION_TIMEOUT },
    });
    expect(
      await rejectionOf(
        withAggregateTransactionBoundary(
          () => budget,
          async () => await Promise.reject(cause),
        ),
      ),
    ).toBe(cause);
  },
);

test.each(
  Object.values(AGGREGATE_TRANSACTION_BUDGETS).filter(
    (budget) => budget.kind === "aggregate",
  ),
)(
  "transaction rejection names the exhausted budget ($reason)",
  async (budget) => {
    const cause = new TransactionBoundaryFixtureError({
      message: "Transaction exceeded its deadline",
      cause: { code: PG_ERROR.TRANSACTION_TIMEOUT },
    });
    const failure = await rejectionOf(
      withAggregateTransactionBoundary(
        () => budget,
        async () => await Promise.reject(cause),
      ),
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
  const budget = AGGREGATE_TRANSACTION_BUDGETS.deadlineProbe;
  const value = { status: "committed" };
  expect(
    await withAggregateTransactionBoundary(
      () => budget,
      async () => value,
    ),
  ).toBe(value);
  for (const payload of [
    { code: PG_ERROR.QUERY_CANCELED },
    { cause: { code: PG_ERROR.SERIALIZATION_FAILURE } },
    null,
  ]) {
    const cause = new TransactionBoundaryFixtureError({
      message: "Unrelated transaction failure",
      cause: payload,
    });
    expect(
      await rejectionOf(
        withAggregateTransactionBoundary(
          () => budget,
          async () => await Promise.reject(cause),
        ),
      ),
    ).toBe(cause);
    expect(cause.cause).toBe(payload);
  }
});
