import { describe, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { setTransactionDeadline } from "@/api/db/shared-pool-timeouts";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const DEADLINE_MS = 300;
const STATEMENT_SLEEP_S = 0.2;

if (!databaseUrl || !runPostgresTests) {
  describe.skip("transaction deadline against Postgres", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  describe("transaction deadline against Postgres", () => {
    test("the server cancels a transaction of short statements that outlasts its deadline", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const error = await rejectionOf(
          async () =>
            await db.transaction(async (tx) => {
              await setTransactionDeadline(tx, DEADLINE_MS);
              // Each statement is far below the deadline; only the
              // transaction as a whole outlasts it.
              for (let step = 0; step < 4; step += 1) {
                await tx.execute(`SELECT pg_sleep(${STATEMENT_SLEEP_S})`);
              }
            }),
        );
        expect(String(error instanceof Error ? error.message : error)).toMatch(
          /transaction timeout/iu,
        );
      });
    });

    test("a transaction within its deadline commits", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        await db.transaction(async (tx) => {
          await setTransactionDeadline(tx, 5000);
          await tx.execute(`SELECT pg_sleep(${STATEMENT_SLEEP_S})`);
        });
      });
    });
  });
}
