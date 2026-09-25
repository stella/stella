import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { withGatedTestClients } from "@/api/tests/gated-test-database";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const queryTimeoutMs = 500;

type ProbeRow = {
  value: number;
};

if (!databaseUrl || !runPostgresTests) {
  describe.skip("database pool isolation", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  describe("database pool isolation", () => {
    test("separate Bun SQL clients do not share a max=1 pool", async () => {
      // Awaited again once both clients are closed: closing ends a held
      // transaction that never reached its release point.
      let heldTransactionSettled: Promise<unknown> = Promise.resolve();

      try {
        await withGatedTestClients(
          databaseUrl,
          async ({ openClient }) => {
            const heldPool = openClient();
            const peerPool = openClient();
            let releaseHeldTransaction: (() => void) | undefined;
            let markTransactionReady: (() => void) | undefined;
            const transactionReady = new Promise<void>((resolve) => {
              markTransactionReady = resolve;
            });

            const heldTransaction = heldPool.db.transaction(async (tx) => {
              await tx.execute(sql`SELECT 1`);

              await new Promise<void>((resolve) => {
                releaseHeldTransaction = resolve;
                markTransactionReady?.();
              });
            });
            heldTransactionSettled = heldTransaction.catch(() => undefined);

            try {
              const readyResult = await Promise.race([
                transactionReady.then(() => "ready" as const),
                heldTransaction,
                Bun.sleep(queryTimeoutMs).then(() => "timeout" as const),
              ]);

              if (readyResult === "timeout") {
                throw new Error("timed out waiting for held transaction");
              }

              const queryResult = await Promise.race([
                peerPool.db.execute(sql<ProbeRow>`SELECT 42::int AS value`),
                Bun.sleep(queryTimeoutMs).then(() => "timeout" as const),
              ]);

              expect(queryResult).not.toBe("timeout");

              if (queryResult !== "timeout") {
                expect(queryResult.at(0)?.["value"]).toBe(42);
              }
            } finally {
              releaseHeldTransaction?.();

              if (releaseHeldTransaction) {
                await heldTransactionSettled;
              }
            }
          },
          { closeTimeout: 0 },
        );
      } finally {
        await heldTransactionSettled;
      }
    });
  });
}
