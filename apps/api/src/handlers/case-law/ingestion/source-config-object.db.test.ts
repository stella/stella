import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { rejectionOf } from "@stll/property-testing/rejection";

import { caseLawSources } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { createTestPglite } from "@/api/tests/pglite-test-db";

// Per-source state is recorded with jsonb_set, which fails on a scalar, so a
// source whose config is the JSON string "{}" could never record any.

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

// timeout: the PGlite schema push builds every table before the first test.
beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
}, 120_000);

afterAll(async () => {
  await client.close();
});

const insertSource = async (config: SQL) =>
  await db.insert(caseLawSources).values({
    id: createSafeId<"caseLawSource">(),
    adapterKey: `config-shape-${createSafeId<"caseLawSource">()}`,
    name: "config shape fixture",
    config,
  });

describe("case_law_sources.config", () => {
  test("refuses a JSON string where the object belongs", async () => {
    const rejection = await rejectionOf(insertSource(sql`'"{}"'::jsonb`));
    // The driver error carries the constraint name on its cause.
    expect(rejection).toMatchObject({
      cause: {
        message: expect.stringContaining("case_law_sources_config_object"),
      },
    });
  });

  test("accepts an object and records per-source state into it", async () => {
    const id = createSafeId<"caseLawSource">();
    await db.insert(caseLawSources).values({
      id,
      adapterKey: `config-shape-${id}`,
      name: "config shape fixture",
    });
    const rows = await db.execute<{ streaks: unknown }>(sql`
      UPDATE case_law_sources
        SET config = jsonb_set(coalesce(config, '{}'::jsonb), '{unavailableItems}', '{"item":1}'::jsonb)
        WHERE id = ${id}
        RETURNING config -> 'unavailableItems' AS streaks`);
    expect(rows.rows).toEqual([{ streaks: { item: 1 } }]);
  });
});
