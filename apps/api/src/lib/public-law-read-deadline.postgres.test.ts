import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { readFailureBrand } from "@stll/errors";

import { executedRows } from "@/api/lib/db/executed-rows";
import { TimeoutError } from "@/api/lib/errors/tagged-errors";
import { runWithinRequestLatencyBudget } from "@/api/lib/load/request-latency-budget";
import { publicLawReadDb } from "@/api/lib/public-law-read-db";
import { isRecord } from "@/api/lib/type-guards";

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
