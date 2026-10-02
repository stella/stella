import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import { AsyncLocalStorage } from "node:async_hooks";

import {
  queryCountLogger,
  runWithQueryCounter,
} from "@/api/lib/db-query-counter";
import { runTransactionsInCallerContext } from "@/api/lib/db/caller-async-context";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const CONCURRENT_REQUESTS = 6;

/**
 * Bun's pool runs a transaction callback when a connection frees up, in the
 * context current at that moment. A request's statements must still count
 * toward that request, whether its transaction opened a new connection or
 * waited for another request to release one.
 */
if (!databaseUrl || !runPostgresTests) {
  describe.skip("transactions in the caller's async context", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  describe("transactions in the caller's async context", () => {
    test("each request counts exactly its own statements on a one-connection pool", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const db = drizzle({
          client: runTransactionsInCallerContext(openClient({ max: 1 }).sql),
          logger: queryCountLogger,
        });
        // Nine statements: two and a savepoint's one in the first
        // transaction, two in each of three concurrent ones, one outside.
        const request = async () =>
          await runWithQueryCounter(async (counter) => {
            await db.transaction(async (tx) => {
              await tx.execute(sql`SELECT 1`);
              await Bun.sleep(5);
              await tx.transaction(async (savepoint) => {
                await savepoint.execute(sql`SELECT 2`);
              });
            });
            await Promise.all(
              [3, 4, 5].map(async (value) => {
                await db.transaction(async (tx) => {
                  await tx.execute(sql`SELECT ${value}`);
                  await tx.execute(sql`SELECT ${value}`);
                });
              }),
            );
            await db.execute(sql`SELECT 6`);
            return counter.count;
          });

        // The first round opens the pool's connection; later rounds wait on it.
        for (const _round of [1, 2, 3]) {
          const counts = await Promise.all(
            Array.from({ length: CONCURRENT_REQUESTS }, request),
          );
          expect(counts).toEqual(
            Array.from({ length: CONCURRENT_REQUESTS }, () => 9),
          );
        }
      });
    });

    test("a transaction opened with options also sees its caller's stores", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const client = runTransactionsInCallerContext(
          openClient({ max: 1 }).sql,
        );
        const caller = new AsyncLocalStorage<number>();
        const seen = await Promise.all(
          Array.from(
            { length: CONCURRENT_REQUESTS },
            async (_, index) =>
              await caller.run(
                index,
                async () =>
                  await client.begin("read only", async (tx) => {
                    await tx`SELECT 1`;
                    return caller.getStore();
                  }),
              ),
          ),
        );
        expect(seen).toEqual(
          Array.from({ length: CONCURRENT_REQUESTS }, (_, index) => index),
        );
      });
    });
  });
}
