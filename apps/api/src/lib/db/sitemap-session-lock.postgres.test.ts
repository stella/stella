import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import * as v from "valibot";

import { withGatedTestClients } from "@/api/tests/gated-test-database";

import {
  caseLawSitemapMonthSessionLockSql,
  tryLockCaseLawSitemapMonth,
  withAggregateTransaction,
} from "./aggregate-lock";
import { AGGREGATE_TRANSACTION_BUDGETS } from "./aggregate-transaction-budget";
import { executedRows } from "./executed-rows";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!enabled)("sitemap session lock (postgres)", () => {
  test("fences refresh transactions while its holder has no open transaction", async () => {
    await withGatedTestClients(
      process.env["DATABASE_URL"] ?? panic("Missing PostgreSQL test URL"),
      async ({ openClient }) => {
        const holder = openClient({ max: 1, idleTimeout: 0 }).db;
        const observer = openClient().db;
        const month = { country: "XSESSION", year: "2024", month: "01" };
        const lock = caseLawSitemapMonthSessionLockSql(month);
        const { pid } = v.parse(
          v.object({ pid: v.number() }),
          executedRows(
            await holder.execute(sql`SELECT pg_backend_pid() AS pid`),
          ).at(0),
        );
        expect(executedRows(await holder.execute(lock.acquire))).toEqual([
          { acquired: true },
        ]);
        try {
          expect(
            executedRows(
              await observer.execute(sql`SELECT state, xact_start IS NULL AS outside_transaction
                FROM pg_stat_activity WHERE pid = ${pid}`),
            ),
          ).toEqual([{ state: "idle", outside_transaction: true }]);
          expect(
            await withAggregateTransaction(
              observer,
              AGGREGATE_TRANSACTION_BUDGETS.deadlineProbe,
              async (tx) => await tryLockCaseLawSitemapMonth({ tx, month }),
            ),
          ).toBe(false);
        } finally {
          expect(executedRows(await holder.execute(lock.release))).toEqual([
            { released: true },
          ]);
        }
        expect(
          await withAggregateTransaction(
            observer,
            AGGREGATE_TRANSACTION_BUDGETS.deadlineProbe,
            async (tx) => await tryLockCaseLawSitemapMonth({ tx, month }),
          ),
        ).toBe(true);
      },
    );
  });
});
