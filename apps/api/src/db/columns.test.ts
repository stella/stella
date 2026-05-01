import { PGlite } from "@electric-sql/pglite";
import { describe, expect, test } from "bun:test";
import { SQL, is, sql } from "drizzle-orm";
import { PgDialect, integer, pgTable } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";

import { jsonb } from "@/api/db/columns";

const table = pgTable("jsonb_column_test", {
  value: jsonb("value"),
});

const roundTripTable = pgTable("jsonb_round_trip_test", {
  id: integer("id").primaryKey(),
  value: jsonb("value"),
});

describe("safe JSONB column", () => {
  test("preserves SQL NULL for nullish values", () => {
    expect(table.value.mapToDriverValue(null)).toBeNull();
    expect(table.value.mapToDriverValue(undefined)).toBeNull();
  });

  test("encodes structured values through a text JSONB cast", () => {
    const encoded = table.value.mapToDriverValue({ nested: ["value"] });

    if (!is(encoded, SQL)) {
      throw new Error("Expected JSONB encoder to return SQL");
    }

    const query = new PgDialect().sqlToQuery(encoded);

    expect(query.sql).toBe("$1::text::jsonb");
    expect(query.params).toEqual(['{"nested":["value"]}']);
  });

  test("does not parse scalar JSON-looking strings from the driver", () => {
    expect(table.value.mapFromDriverValue("123")).toBe("123");
    expect(table.value.mapFromDriverValue("true")).toBe("true");
    expect(table.value.mapFromDriverValue('"quoted"')).toBe('"quoted"');
  });

  test("decodes legacy object and array JSON text", () => {
    expect(table.value.mapFromDriverValue('{"nested":["value"]}')).toEqual({
      nested: ["value"],
    });
    expect(table.value.mapFromDriverValue('["value"]')).toEqual(["value"]);
  });

  test("persists structured values as JSONB and null as SQL NULL", async () => {
    const client = await PGlite.create();
    const db = drizzle({ client });

    try {
      await db.execute(
        sql.raw(
          "CREATE TABLE jsonb_round_trip_test (id integer PRIMARY KEY, value jsonb)",
        ),
      );

      await db.insert(roundTripTable).values([
        { id: 1, value: { nested: ["value"] } },
        { id: 2, value: ["value"] },
        { id: 3, value: null },
      ]);

      const result = await db.execute<{
        id: number;
        kind: "array" | "object" | null;
        isNull: boolean;
      }>(
        sql.raw(`
          SELECT
            id,
            jsonb_typeof(value) AS kind,
            value IS NULL AS "isNull"
          FROM jsonb_round_trip_test
          ORDER BY id
        `),
      );

      expect(result.rows).toEqual([
        { id: 1, kind: "object", isNull: false },
        { id: 2, kind: "array", isNull: false },
        { id: 3, kind: null, isNull: true },
      ]);
    } finally {
      await client.close();
    }
  });
});
