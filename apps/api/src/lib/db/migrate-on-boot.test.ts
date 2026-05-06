import { describe, expect, test } from "bun:test";
import { SQL, is } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { runBootMigrations } from "@/api/lib/db/migrate-on-boot";

describe("boot migrations", () => {
  test("holds the advisory lock before running migrations", async () => {
    const events: string[] = [];
    const dialect = new PgDialect();
    const tx = {
      execute: async (query: SQLWrapper | string): Promise<void> => {
        if (!is(query, SQL)) {
          throw new Error("expected advisory lock query");
        }

        events.push(dialect.sqlToQuery(query).sql);
      },
    };
    const database = {
      transaction: async <T>(fn: (transaction: typeof tx) => Promise<T>) => {
        events.push("transaction:start");
        const result = await fn(tx);
        events.push("transaction:end");
        return result;
      },
    };

    await runBootMigrations(database, async () => {
      events.push("migrate");
    });

    expect(events).toEqual([
      "transaction:start",
      "SELECT pg_advisory_xact_lock($1, $2)",
      "migrate",
      "transaction:end",
    ]);
  });
});
