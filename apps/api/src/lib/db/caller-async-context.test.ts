import { panic } from "better-result";
import type { SQL } from "bun";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { rejectionOf } from "@stll/property-testing/rejection";

import { createDatabase } from "@/api/db/sql-client";
import {
  instrumentSqlTransactionCounts,
  queryCountLogger,
  runWithQueryCounter,
} from "@/api/lib/db-query-counter";
import { runTransactionsInCallerContext } from "@/api/lib/db/caller-async-context";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

// The native begin boundary is faked; no connection is opened. Drizzle still
// owns transaction construction and invokes the native savepoint boundary.
const withTransactionClient = async (run: (client: SQL) => Promise<void>) =>
  await withGatedTestClients(
    "postgres://test:test@localhost:1/test",
    async ({ openClient }) => {
      const { sql: client } = openClient();
      Object.defineProperty(client, "begin", {
        configurable: true,
        value: async <const T>(
          optionsOrCallback: string | SQL.ContextCallback<T, SQL>,
          callback?: SQL.ContextCallback<T, SQL>,
        ) => {
          const transaction =
            typeof optionsOrCallback === "string"
              ? callback
              : optionsOrCallback;
          if (transaction === undefined) {
            panic("missing fake transaction callback");
          }
          return await transaction(client);
        },
      });
      Object.defineProperty(client, "unsafe", {
        value: async () =>
          Object.assign(Promise.resolve([]), { values: async () => [] }),
      });
      Object.defineProperty(client, "savepoint", {
        value: async <const T>(callback: SQL.ContextCallback<T, SQL>) =>
          await callback(client),
      });
      const wrapped = runTransactionsInCallerContext(client);
      expect(runTransactionsInCallerContext(wrapped)).toBe(wrapped);
      await run(instrumentSqlTransactionCounts(wrapped));
    },
  );

describe("native transaction statement accounting", () => {
  for (const options of [undefined, "read only"]) {
    test(`counts transaction controls with options ${String(options)}`, async () => {
      await withTransactionClient(async (client) => {
        await runWithQueryCounter(async (counter) => {
          const query = async () => {
            queryCountLogger.logQuery("SELECT 1", []);
            return "result";
          };
          const result =
            options === undefined
              ? await client.begin(query)
              : await client.begin(options, query);
          expect(result).toBe("result");
          expect(counter.count).toBe(1);
          expect(counter.transactions).toBe(2);
          expect(counter.count + counter.transactions).toBe(3);
        });
      });
    });
  }

  test("counts rollback and propagates the original rejection", async () => {
    await withTransactionClient(async (client) => {
      await runWithQueryCounter(async (counter) => {
        expect(
          await rejectionOf(
            client.begin(async () => {
              queryCountLogger.logQuery("SELECT 1", []);
              panic("transaction rejected");
            }),
          ),
        ).toMatchObject({ message: "transaction rejected" });
        expect(counter.count).toBe(1);
        expect(counter.transactions).toBe(2);
        expect(counter.count + counter.transactions).toBe(3);
      });
    });
  });

  test("counts one native transaction around nested Drizzle savepoints", async () => {
    await withTransactionClient(async (client) => {
      const db = createDatabase({ client, logger: queryCountLogger });
      await runWithQueryCounter(async (counter) => {
        await db.transaction(async (tx) => {
          await tx.execute(sql`SELECT 1`);
          await tx.transaction(async (savepoint) => {
            await savepoint.execute(sql`SELECT 2`);
          });
        });
        expect(counter.count).toBe(2);
        expect(counter.transactions).toBe(2);
        expect(counter.count + counter.transactions).toBe(4);
      });
    });
  });
});
