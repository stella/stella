import { SQL } from "bun";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const queryTimeoutMs = 500;

type ProbeRow = {
  value: number;
};

const createMaxOnePool = (url: string) => {
  const client = new SQL({ url, max: 1 });

  return {
    client,
    db: drizzle({ client }),
  };
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
      const heldPool = createMaxOnePool(databaseUrl);
      const peerPool = createMaxOnePool(databaseUrl);
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
        const heldTransactionSettled = heldTransaction.catch(() => undefined);
        releaseHeldTransaction?.();

        if (releaseHeldTransaction) {
          await heldTransactionSettled;
        }

        await heldPool.client.close({ timeout: 0 });
        await peerPool.client.close({ timeout: 0 });
        await heldTransactionSettled;
      }
    });
  });
}
