import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { rejectionOf } from "@stll/property-testing/rejection";

import { runWithQueryCounter } from "@/api/lib/db-query-counter";

import { withLongRunningConnection } from "./long-running-connection";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!enabled)("dedicated SQL counting with PostgreSQL", () => {
  test("the actual reserved Drizzle and raw paths count once and preserve native query helpers", async () => {
    await runWithQueryCounter(async (counter) => {
      await withLongRunningConnection(
        {
          statementTimeout: 1000,
          lockTimeout: 100,
          signal: new AbortController().signal,
        },
        async ({ db, connection }) => {
          // Backend identity and the authenticated-login posture query both ran.
          expect(counter.count).toBe(2);
          const raw = connection.unsafe("SELECT 17::int AS value");
          expect(counter.count).toBe(2);
          expect(raw.execute()).toBe(raw);
          expect(await raw).toEqual([{ value: 17 }]);
          expect(counter.count).toBe(3);
          expect(await db.execute(sql`SELECT 18::int AS value`)).toEqual([
            { value: 18 },
          ]);
          expect(counter.count).toBe(4);
          await db.transaction(async (transaction) => {
            expect(
              await transaction.execute(sql`SELECT 19::int AS value`),
            ).toEqual([{ value: 19 }]);
            await transaction.transaction(async (nested) => {
              expect(
                await nested.execute(sql`SELECT 20::int AS value`),
              ).toEqual([{ value: 20 }]);
            });
          });
          expect(counter.count).toBe(6);
          // Only BEGIN/COMMIT count; the nested savepoint controls do not.
          expect(counter.transactions).toBe(2);
          const fragment = connection.unsafe("21::int");
          const values = connection`SELECT ${fragment} AS value`.values();
          expect(counter.count).toBe(6);
          expect(await values).toEqual([[21]]);
          expect(counter.count).toBe(7);
          await db.execute(
            sql`CREATE TEMP TABLE dedicated_counter_values (value integer)`,
          );
          const helper = connection([{ value: 22 }]);
          const table = connection("dedicated_counter_values");
          expect(
            await connection`INSERT INTO ${table} ${helper} RETURNING value`,
          ).toEqual([{ value: 22 }]);
          expect(counter.count).toBe(9);
          const rows = await raw.then((result) => result);
          expect(rows).toEqual([{ value: 17 }]);
          expect(counter.count).toBe(9);
        },
      );
      expect(counter.count).toBe(9);
      expect(counter.transactions).toBe(2);
    });
  });

  test("the actual cancellation connection belongs to the dedicated task", async () => {
    const controller = new AbortController();
    await runWithQueryCounter(async (counter) => {
      const failure = await rejectionOf(
        withLongRunningConnection(
          {
            statementTimeout: 1000,
            lockTimeout: 100,
            signal: controller.signal,
          },
          async ({ connection }) => {
            expect(await connection.unsafe("SELECT 1::int AS value")).toEqual([
              { value: 1 },
            ]);
            controller.abort(
              new DOMException("dedicated fixture completed", "AbortError"),
            );
          },
        ),
      );
      expect(failure).toMatchObject({
        name: "AbortError",
        message: "dedicated fixture completed",
      });
      expect(counter.count).toBe(4);
      expect(counter.transactions).toBe(0);
    });
  });
});
