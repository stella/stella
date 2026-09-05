import { SQL } from "bun";
/**
 * Two sessions contend for the maintenance lane on a real Postgres: the
 * second may not start until the first releases. PGlite cannot stand in here
 * because it serves one session, and a session-level advisory lock is only
 * meaningful across sessions. The read-only door is proved the same way: a
 * write through it must be refused by the server, not by a convention.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import {
  holdCaseLawMaintenanceLane,
  openCaseLawReadOnlySession,
} from "@/api/lib/case-law/maintenance-lane";
import { PG_ERROR, getPgErrorCode } from "@/api/lib/pg-error";

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
      const first = await holdCaseLawMaintenanceLane({
        sql: new SQL({ url: databaseUrl, max: 1 }),
      });
      const order: string[] = [];
      const second = holdCaseLawMaintenanceLane({
        sql: new SQL({ url: databaseUrl, max: 1 }),
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
