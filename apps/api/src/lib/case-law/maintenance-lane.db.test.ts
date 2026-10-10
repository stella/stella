/**
 * Two sessions contend for the maintenance lane on a real Postgres: the
 * second may not start until the first releases. PGlite cannot stand in here
 * because it serves one session, and a session-level advisory lock is only
 * meaningful across sessions. The read-only door is proved the same way: a
 * write through it must be refused by the server, not by a convention.
 */
import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import {
  enterCaseLawMaintenanceLane,
  holdCaseLawMaintenanceLane,
  openCaseLawReadOnlySession,
} from "@/api/lib/case-law/maintenance-lane";
import { PG_ERROR, getPgErrorCode } from "@/api/lib/pg-error";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !runPostgresTests) {
  describe.skip("case-law maintenance lane (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(true).toBe(true);
    });
  });
} else {
  describe("case-law maintenance lane (postgres)", () => {
    test("a second pass waits until the first releases", async () => {
      // A release ends its session; the scope closes whichever did not get
      // that far, without waiting on a lock request that is still blocked.
      await withGatedTestClients(
        databaseUrl,
        async ({ openClient }) => {
          const first = await holdCaseLawMaintenanceLane({
            sql: openClient().sql,
          });
          const order: string[] = [];
          const second = holdCaseLawMaintenanceLane({
            sql: openClient().sql,
          }).then((hold) => {
            order.push("second-entered");
            return hold;
          });
          // Give the second session time to block on the lock.
          await Bun.sleep(300);
          order.push("first-releasing");
          await first.release();
          const secondHold = await second;
          expect(order).toEqual(["first-releasing", "second-entered"]);
          expect(secondHold.waitedMs).toBeGreaterThanOrEqual(250);
          await secondHold.release();
        },
        { closeTimeout: 0 },
      );
    });

    test("the bounded door skips a held lane without starting work", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const held = await holdCaseLawMaintenanceLane({
          sql: openClient().sql,
        });
        try {
          const skipped = await enterCaseLawMaintenanceLane({
            mode: "bounded",
            signal: AbortSignal.timeout(10_000),
            statementTimeout: 5000,
            lockTimeout: 5000,
            work: async () =>
              panic("Contended maintenance work must not start"),
          });
          expect(skipped).toBeNull();
        } finally {
          await held.release();
        }
      });
    });

    test("the bounded door serializes root and ingestion work on one backend and releases after failure", async () => {
      const roles = await enterCaseLawMaintenanceLane({
        mode: "bounded",
        signal: AbortSignal.timeout(10_000),
        statementTimeout: 5000,
        lockTimeout: 5000,
        work: async ({ rootDb, ingestionDb }) =>
          await Promise.all([
            rootDb.transaction(async (tx) =>
              (
                await tx.execute<{ pid: number; role: string }>(
                  sql`SELECT pg_backend_pid() AS pid, current_user AS role, pg_sleep(0.01)`,
                )
              ).at(0),
            ),
            ingestionDb(async (tx) =>
              (
                await tx.execute<{ pid: number; role: string }>(
                  sql`SELECT pg_backend_pid() AS pid, current_user AS role`,
                )
              ).at(0),
            ),
            rootDb.transaction(async (tx) =>
              (
                await tx.execute<{ pid: number; role: string }>(
                  sql`SELECT pg_backend_pid() AS pid, current_user AS role`,
                )
              ).at(0),
            ),
          ]),
      });
      if (roles === null) {
        panic("Expected uncontended bounded maintenance lane");
      }
      expect(new Set(roles.map((row) => row?.pid)).size).toBe(1);
      expect(roles.at(0)?.role).not.toBe("stella_ingestion");
      expect(roles.at(1)?.role).toBe("stella_ingestion");
      expect(roles.at(2)?.role).toBe(roles.at(0)?.role);
      const failed = await Result.tryPromise(
        async () =>
          await enterCaseLawMaintenanceLane({
            mode: "bounded",
            signal: AbortSignal.timeout(10_000),
            statementTimeout: 5000,
            lockTimeout: 5000,
            work: async () => panic("Deliberate fixture work failure"),
          }),
      );
      expect(failed.isErr()).toBe(true);
      expect(
        await enterCaseLawMaintenanceLane({
          mode: "bounded",
          signal: AbortSignal.timeout(10_000),
          statementTimeout: 5000,
          lockTimeout: 5000,
          work: async () => "released",
        }),
      ).toBe("released");
    });

    test("the read-only door refuses a write with 25006", async () => {
      const { rootDb, ingestionDb } = await openCaseLawReadOnlySession();
      const codes: (string | undefined)[] = [];
      for (const run of [
        async () =>
          await rootDb.execute(
            sql`UPDATE case_law_sources SET last_sync_at = now() WHERE false`,
          ),
        async () =>
          await ingestionDb(
            async (tx) =>
              await tx.execute(
                sql`UPDATE case_law_sources SET last_sync_at = now() WHERE false`,
              ),
          ),
      ]) {
        await run().then(
          () => codes.push(undefined),
          (error: unknown) => codes.push(getPgErrorCode(error)),
        );
      }
      expect(codes).toEqual([
        PG_ERROR.READ_ONLY_SQL_TRANSACTION,
        PG_ERROR.READ_ONLY_SQL_TRANSACTION,
      ]);
    });
  });
}
