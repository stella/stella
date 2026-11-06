import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

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

describe("case_law_sources.config", () => {
  test("the ingestion role records per-source state into the config object", async () => {
    const id = createSafeId<"caseLawSource">();
    await db.insert(caseLawSources).values({
      id,
      adapterKey: `config-shape-${id}`,
      name: "config shape fixture",
    });
    // Under the deployment role, so a missing column grant fails here too.
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE stella_ingestion`);
      return await tx.execute<{ streaks: unknown }>(sql`
        UPDATE case_law_sources
          SET config = jsonb_set(coalesce(config, '{}'::jsonb), '{unavailableItems}', '{"item":1}'::jsonb)
          WHERE id = ${id}
          RETURNING config -> 'unavailableItems' AS streaks`);
    });
    expect(rows.rows).toEqual([{ streaks: { item: 1 } }]);
  });
});
