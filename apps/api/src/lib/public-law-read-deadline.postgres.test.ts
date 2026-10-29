import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { readFailureBrand } from "@stll/errors";
import { waitForExternalState } from "@stll/property-testing/external-state";

import { executedRows } from "@/api/lib/db/executed-rows";
import { abortTransaction } from "@/api/lib/db/transaction-abort";
import { TimeoutError } from "@/api/lib/errors/tagged-errors";
import { runWithPublicReadStatementTimeout } from "@/api/lib/legal-search/public-read-timeout-context";
import {
  remainingRequestBudgetMs,
  runWithinRequestLatencyBudget,
} from "@/api/lib/load/request-latency-budget";
import { failureSink, gradeFailure } from "@/api/lib/observability/failure";
import { readEvidence } from "@/api/lib/observability/failure-evidence";
import { getPgErrorCode, PG_ERROR } from "@/api/lib/pg-error";
import { publicLawReadDb } from "@/api/lib/public-law-read-db";
import { isRecord } from "@/api/lib/type-guards";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgres = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const BUDGET_MS = 2000;
/** Each statement alone fits the budget; two in a row do not. */
const STATEMENT_SECONDS = 1.5;
/** Slack for the server to end the session and the client to see it. */
const DEADLINE_SLACK_MS = 700;

const transactionTimeout = async (tx: {
  execute: (query: ReturnType<typeof sql>) => Promise<unknown>;
}): Promise<string> => {
  const [row] = executedRows(
    await tx.execute(
      sql`SELECT current_setting('transaction_timeout') AS value`,
    ),
  );
  return isRecord(row) ? String(row["value"]) : "";
};

if (!databaseUrl || !runPostgres) {
  describe.skip("public-law reads under a request budget (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  describe("public-law reads under a request budget (postgres)", () => {
    test("successive statements cannot outlast the request together", async () => {
      // real-time: the deadline under test is the server's wall clock.
      const startedAt = performance.now();
      const outcome = await runWithinRequestLatencyBudget(
        { label: "read_statute", budgetMs: BUDGET_MS },
        async () =>
          await Result.tryPromise({
            try: async () =>
              await publicLawReadDb(async (tx) => {
                await tx.execute(sql`SELECT pg_sleep(${STATEMENT_SECONDS})`);
                await tx.execute(sql`SELECT pg_sleep(${STATEMENT_SECONDS})`);
                return "answered late";
              }),
            catch: (cause) => cause,
          }),
      );
      const elapsedMs = performance.now() - startedAt;

      expect(Result.isError(outcome)).toBe(true);
      const error = Result.isError(outcome) ? outcome.error : undefined;
      expect(error).toBeInstanceOf(TimeoutError);
      expect(readFailureBrand(error)).toEqual({
        reason: "timeout_budgeted",
        source: "instance",
      });
      // Ended at the deadline, not after both statements.
      expect(elapsedMs).toBeGreaterThanOrEqual(BUDGET_MS - 50);
      expect(elapsedMs).toBeLessThan(BUDGET_MS + DEADLINE_SLACK_MS);

      // The pool replaces the ended session and keeps answering.
      expect(
        await publicLawReadDb(
          async (tx) =>
            executedRows(await tx.execute(sql`SELECT 1 AS one`)).length,
        ),
      ).toBe(1);
    });

    test("a statement timeout the request clamped is the budget's", async () => {
      // A 500 ms budget shortens the read's 30 s statement cap; rounding up
      // keeps the server's timeout at or beyond the request deadline.
      const outcome = await runWithinRequestLatencyBudget(
        { label: "read_statute", budgetMs: 500 },
        async () =>
          await Result.tryPromise({
            try: async () =>
              await publicLawReadDb(async (tx) => {
                await tx.execute(sql`SELECT pg_sleep(2)`);
                return "answered late";
              }),
            catch: (cause) => cause,
          }),
      );
      const error = Result.isError(outcome) ? outcome.error : undefined;
      expect(error).toBeInstanceOf(TimeoutError);
      expect(readFailureBrand(error)).toEqual({
        reason: "timeout_budgeted",
        source: "instance",
      });
    });

    test("an explicit cancel of a clamped statement keeps its error and grade before the deadline", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const observer = openClient({ max: 1 }).sql;
        const backend = Promise.withResolvers<number>();
        let statementError: unknown;
        const sink = failureSink({
          event: "public-law-read.test",
          expected: [],
        });
        const outcome = await runWithinRequestLatencyBudget(
          { label: "read_statute", budgetMs: 10_000 },
          async () => {
            const read = Result.tryPromise({
              try: async () =>
                await publicLawReadDb(async (tx) => {
                  const row = executedRows(
                    await tx.execute(
                      sql`SELECT pg_backend_pid() AS pid, current_setting('statement_timeout')::interval < interval '30 seconds' AS clamped`,
                    ),
                  ).at(0);
                  expect(isRecord(row) && row["clamped"]).toBe(true);
                  if (!isRecord(row) || typeof row["pid"] !== "number") {
                    return panic("Missing reading backend pid");
                  }
                  backend.resolve(row["pid"]);
                  const statement = await Result.tryPromise({
                    try: async () => await tx.execute(sql`SELECT pg_sleep(20)`),
                    catch: (cause) => cause,
                  });
                  if (Result.isError(statement)) {
                    statementError = statement.error;
                    return abortTransaction(statement.error);
                  }
                  return "answered late";
                }),
              catch: (cause) => {
                backend.reject(cause);
                return cause;
              },
            });
            const pid = await backend.promise;
            await waitForExternalState({
              description: "the reading backend is executing pg_sleep",
              read: async () =>
                (
                  await observer`SELECT wait_event FROM pg_stat_activity WHERE pid = ${pid}`
                ).at(0)?.["wait_event"] === "PgSleep",
            });
            expect(remainingRequestBudgetMs()).toBeGreaterThan(5000);
            expect(
              (await observer`SELECT pg_cancel_backend(${pid}) AS canceled`).at(
                0,
              )?.["canceled"],
            ).toBe(true);
            return await read;
          },
        );
        const error = Result.isError(outcome) ? outcome.error : undefined;
        expect(error).toBe(statementError);
        expect(error).not.toBeInstanceOf(TimeoutError);
        expect(getPgErrorCode(error)).toBe(PG_ERROR.QUERY_CANCELED);
        expect(readFailureBrand(error)?.reason).not.toBe("timeout_budgeted");
        expect(gradeFailure(readEvidence(error), sink)).toEqual(
          gradeFailure(readEvidence(statementError), sink),
        );
        expect(gradeFailure(readEvidence(error), sink).reason).toBe(
          "pg_query_canceled",
        );
      });
    });

    test("a statement cap of the read's own keeps its own error inside the budget", async () => {
      // The route's 100 ms cap is shorter than what the 2000 ms budget leaves,
      // so the budget shortened nothing: the cancel is the read's own and
      // keeps the grade monitoring sees for it.
      const outcome = await runWithinRequestLatencyBudget(
        { label: "read_statute", budgetMs: BUDGET_MS },
        async () =>
          await runWithPublicReadStatementTimeout(
            { budgetMs: 100 },
            async () =>
              await Result.tryPromise({
                try: async () =>
                  await publicLawReadDb(async (tx) => {
                    await tx.execute(sql`SELECT pg_sleep(1)`);
                    return "answered late";
                  }),
                catch: (cause) => cause,
              }),
          ),
      );
      const error = Result.isError(outcome) ? outcome.error : undefined;
      expect(error).not.toBeInstanceOf(TimeoutError);
      expect(getPgErrorCode(error)).toBe(PG_ERROR.QUERY_CANCELED);
      expect(readFailureBrand(error)?.reason).not.toBe("timeout_budgeted");
    });

    test("a read inside its budget answers, and a read outside a scope keeps no deadline", async () => {
      const scoped = await runWithinRequestLatencyBudget(
        { label: "read_statute", budgetMs: BUDGET_MS },
        async () =>
          await publicLawReadDb(async (tx) => {
            await tx.execute(sql`SELECT pg_sleep(0.05)`);
            return await transactionTimeout(tx);
          }),
      );
      expect(scoped).not.toBe("0");

      expect(
        await publicLawReadDb(async (tx) => await transactionTimeout(tx)),
      ).toBe("0");
    });
  });
}
