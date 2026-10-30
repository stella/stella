import { describe, expect, test } from "bun:test";
import { sql as drizzleSql } from "drizzle-orm";

import { rejectionOf } from "@stll/property-testing/rejection";

import { getPgErrorCode } from "@/api/lib/pg-error";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

import { withAggregateTransaction } from "./aggregate-lock";
import {
  AGGREGATE_TRANSACTION_BUDGETS,
  AggregateTransactionTimeoutError,
} from "./aggregate-transaction-budget";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !enabled) {
  describe.skip("aggregate transaction budget (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  describe("aggregate transaction budget (postgres)", () => {
    // timeout: the five-second database deadline must expire before the assertion.
    test("cancels cumulative short statements and names the budget", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const failure = await rejectionOf(
          withAggregateTransaction(
            openClient({ max: 1 }).db,
            AGGREGATE_TRANSACTION_BUDGETS.requestPath,
            async (tx) => {
              await tx.execute(
                drizzleSql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`,
              );
              await tx.execute(
                drizzleSql`SELECT set_config('statement_timeout', '4s', true)`,
              );
              await tx.execute(drizzleSql`SELECT pg_sleep(3)`);
              await tx.execute(drizzleSql`SELECT pg_sleep(3)`);
            },
          ),
        );
        expect(failure).toBeInstanceOf(AggregateTransactionTimeoutError);
        if (!(failure instanceof AggregateTransactionTimeoutError)) {
          throw failure;
        }
        expect(failure.budget).toBe(AGGREGATE_TRANSACTION_BUDGETS.requestPath);
        expect(getPgErrorCode(failure.cause)).toBe("25P04");
      });
    }, 10_000);
  });
}
