import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { bigint, pgTable } from "drizzle-orm/pg-core";

import { rejectionOf } from "@stll/property-testing/rejection";

import { createDatabase } from "@/api/db/sql-client";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

// Above Number.MAX_SAFE_INTEGER: a string or Number decoding loses or reorders it.
const LARGE = 9_007_199_254_740_993n;

const int8Modes = pgTable("int8_modes", {
  asBigint: bigint("as_bigint", { mode: "bigint" }),
  asNumber: bigint("as_number", { mode: "number" }),
});

describe.skipIf(!enabled)("int8 decoding with PostgreSQL", () => {
  test("raw client reads decode every int8 as BigInt", async () => {
    if (databaseUrl === undefined) {
      throw new TypeError("DATABASE_URL required");
    }
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const client = openClient({ max: 1 }).sql;
      const [row] =
        await client`SELECT 9::int8 AS small, 10::int8 AS ten, ${LARGE.toString()}::int8 AS large, count(*) AS rows FROM (VALUES (1), (2)) AS v(x)`;
      expect(row).toEqual({ small: 9n, ten: 10n, large: LARGE, rows: 2n });
      expect(row.ten > row.small).toBe(true);
    });
  });

  test("drizzle columns decode int8 to their declared mode", async () => {
    if (databaseUrl === undefined) {
      throw new TypeError("DATABASE_URL required");
    }
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const client = openClient({ max: 1 }).sql;
      const db = createDatabase({ client });
      await db.execute(
        sql`CREATE TEMP TABLE int8_modes (as_bigint int8, as_number int8)`,
      );
      await db.insert(int8Modes).values([
        { asBigint: 9n, asNumber: 9 },
        { asBigint: LARGE, asNumber: 10 },
      ]);
      const rows = await db
        .select()
        .from(int8Modes)
        .orderBy(int8Modes.asBigint);
      expect(rows).toEqual([
        { asBigint: 9n, asNumber: 9 },
        { asBigint: LARGE, asNumber: 10 },
      ]);
      // mode number refuses a value it cannot represent exactly.
      await db.execute(
        sql`UPDATE int8_modes SET as_number = ${LARGE.toString()}::int8`,
      );
      const refused = await rejectionOf(db.select().from(int8Modes));
      expect(String(refused)).toContain("not a safe integer");
    });
  });
});
