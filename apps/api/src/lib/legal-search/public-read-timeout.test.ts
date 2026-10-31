import { expect, test } from "bun:test";

import {
  AGGREGATE_TRANSACTION_BUDGETS,
  AggregateTransactionTimeoutError,
} from "@/api/lib/db/aggregate-transaction-budget";
import { PG_ERROR } from "@/api/lib/pg-error";

import { PublicLawStatementError } from "./public-law-statement-error";
import {
  PUBLIC_READ_TIMEOUT_CODE,
  publicReadTimeoutError,
} from "./public-read-timeout";
import { runWithPublicReadStatementTimeout } from "./public-read-timeout-context";

test.each([PG_ERROR.QUERY_CANCELED, PG_ERROR.TRANSACTION_TIMEOUT])(
  "an observed public statement deadline returns the public timeout refusal (%s)",
  (code) => {
    const error = new PublicLawStatementError({
      message: "Public SQL failed",
      cause: { code },
    });
    const refusal = runWithPublicReadStatementTimeout(
      { budgetMs: 30_000 },
      () => publicReadTimeoutError(error),
    );
    expect(refusal).toMatchObject({
      status: 503,
      code: PUBLIC_READ_TIMEOUT_CODE,
    });
    expect(publicReadTimeoutError(error)).toBeNull();
  },
);

test("a public transaction deadline retains its timeout refusal even after commit fails", () => {
  const budget = AGGREGATE_TRANSACTION_BUDGETS.publicReadRequest;
  const error = new AggregateTransactionTimeoutError({
    message: "Transaction expired",
    cause: { code: PG_ERROR.TRANSACTION_TIMEOUT },
    budget,
    reason: budget.reason,
  });
  expect(
    runWithPublicReadStatementTimeout({ budgetMs: budget.milliseconds }, () =>
      publicReadTimeoutError(error),
    ),
  ).toMatchObject({ status: 503, code: PUBLIC_READ_TIMEOUT_CODE });
});

test("an unobserved or unrelated SQL error is not relabelled as a public timeout", () => {
  for (const error of [
    { code: PG_ERROR.TRANSACTION_TIMEOUT },
    new PublicLawStatementError({
      message: "Write refused",
      cause: { code: PG_ERROR.UNIQUE_VIOLATION },
    }),
  ]) {
    expect(
      runWithPublicReadStatementTimeout({ budgetMs: 30_000 }, () =>
        publicReadTimeoutError(error),
      ),
    ).toBeNull();
  }
});
