import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { AsyncLocalStorage } from "node:async_hooks";

import { rejectionOf } from "@stll/property-testing/rejection";

import { createDatabase } from "@/api/db/sql-client";
import { instrumentRootPoolTransactions } from "@/api/lib/db/root-pool-reservation";
import { readRootPoolSnapshot } from "@/api/lib/db/root-pool-snapshot";
import { createRootPoolWindow } from "@/api/lib/observability/root-pool-window";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!enabled)("root pool observation with PostgreSQL", () => {
  test("counts this pool only and excludes the observing query from saturation", async () => {
    if (databaseUrl === undefined) {
      throw new TypeError("DATABASE_URL required");
    }
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const client = openClient({
        max: 1,
        connection: { application_name: Bun.randomUUIDv7() },
      }).sql;
      await openClient({
        max: 1,
        connection: { application_name: Bun.randomUUIDv7() },
      }).sql`SELECT 1`;
      const result = await readRootPoolSnapshot(client);
      expect(result.isOk()).toBe(true);
      if (result.isErr()) {
        throw result.error;
      }
      expect(result.value).toEqual({ size: 1, inUse: 0, idle: 1 });
    });
  });

  test("counts a busy root transaction and returns a typed failure when no slot can be observed", async () => {
    if (databaseUrl === undefined) {
      throw new TypeError("DATABASE_URL required");
    }
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const client = openClient({
        max: 2,
        connection: { application_name: Bun.randomUUIDv7() },
      }).sql;
      using held = await client.reserve();
      await held`BEGIN`;
      try {
        const result = await readRootPoolSnapshot(client);
        expect(result.isOk()).toBe(true);
        if (result.isErr()) {
          throw result.error;
        }
        expect(result.value).toEqual({ size: 2, inUse: 1, idle: 1 });
      } finally {
        await held`ROLLBACK`;
      }
      const unavailable = openClient({ max: 1 }).sql;
      using _blocker = await unavailable.reserve();
      const result = await readRootPoolSnapshot(unavailable);
      expect(result.isErr()).toBe(true);
      if (result.isOk()) {
        throw new TypeError(
          "Observation should time out waiting for the held slot",
        );
      }
      expect(result.error.message).toBe("Root pool snapshot unavailable");
    });
  });

  test("instrumented transactions preserve caller context, savepoints, commit and rollback", async () => {
    if (databaseUrl === undefined) {
      throw new TypeError("DATABASE_URL required");
    }
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      let time = 0;
      const window = createRootPoolWindow({
        now: () => time,
        random: () => 0,
      });
      const client = instrumentRootPoolTransactions(
        openClient({ max: 1 }).sql,
        window,
      );
      const db = createDatabase({ client });
      const context = new AsyncLocalStorage<string>();
      await db.execute(
        sql`CREATE TEMP TABLE root_pool_observation (value integer)`,
      );
      await context.run(
        "caller",
        async () =>
          await db.transaction(async (tx) => {
            expect(context.getStore()).toBe("caller");
            await tx.execute(sql`INSERT INTO root_pool_observation VALUES (1)`);
            await tx.transaction(async (nested) => {
              expect(context.getStore()).toBe("caller");
              await nested.execute(
                sql`INSERT INTO root_pool_observation VALUES (2)`,
              );
            });
            time = 500;
          }),
      );
      const failure = new TypeError("transaction work failed");
      expect(
        await rejectionOf(
          db.transaction(async (tx) => {
            await tx.execute(sql`INSERT INTO root_pool_observation VALUES (3)`);
            throw failure;
          }),
        ),
      ).toBe(failure);
      expect(
        await db.execute(
          sql`SELECT value FROM root_pool_observation ORDER BY value`,
        ),
      ).toEqual([{ value: 1 }, { value: 2 }]);
      const readOnlyResult = await client.begin(
        "read only",
        async (session) =>
          await session`SELECT current_setting('transaction_read_only') AS enabled`,
      );
      expect(readOnlyResult).toEqual([{ enabled: "on" }]);
      expect(
        window.flush(1, { status: "observed", size: 1, inUse: 0, idle: 1 }),
      ).toMatchObject({
        waitingRequests: 0,
        inUseTransactions: 0,
        inUseTransactionsPeak: 1,
        waitSamples: 1,
        waitMaxMs: 0,
        acquisitionFailures: 0,
      });
    });
  });
});
