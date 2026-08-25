import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { corpusIndexGenerations } from "@/api/db/schema";
import { createTestPglite } from "@/api/tests/pglite-test-db";

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

beforeAll(
  async () => {
    client = await createTestPglite();
    db = drizzle({ client });
  },
  { timeout: 120_000 },
);

afterAll(async () => {
  await client.close();
});

test("each family can serve exactly one independently routed generation", async () => {
  await db.insert(corpusIndexGenerations).values([
    {
      cluster: "quickwit_08",
      family: "case_law",
      generation: "case_law_v2",
      status: "serving",
    },
    {
      cluster: "quickwit_09",
      family: "case_law",
      generation: "case_law_v5",
      status: "building",
    },
    {
      cluster: "quickwit_08",
      family: "legislation",
      generation: "legislation_v1",
      status: "serving",
    },
  ]);

  await expect(
    db.insert(corpusIndexGenerations).values({
      cluster: "quickwit_09",
      family: "case_law",
      generation: "case_law_v6",
      status: "serving",
    }),
  ).rejects.toThrow();

  const serving = await db
    .select({
      cluster: corpusIndexGenerations.cluster,
      family: corpusIndexGenerations.family,
      generation: corpusIndexGenerations.generation,
    })
    .from(corpusIndexGenerations)
    .where(eq(corpusIndexGenerations.status, "serving"))
    .orderBy(corpusIndexGenerations.family);

  expect(serving).toEqual([
    {
      cluster: "quickwit_08",
      family: "case_law",
      generation: "case_law_v2",
    },
    {
      cluster: "quickwit_08",
      family: "legislation",
      generation: "legislation_v1",
    },
  ]);
});

test("database constraints reject drift outside the TypeScript contract", async () => {
  await expect(
    db.execute(sql`
      INSERT INTO corpus_index_generations (family, generation, cluster, status)
      VALUES ('case_law', 'legislation_v2', 'quickwit_09', 'building')
    `),
  ).rejects.toThrow();

  await expect(
    db.execute(sql`
      INSERT INTO corpus_index_generations (family, generation, cluster, status)
      VALUES ('legislation', 'legislation_v2', 'quickwit_10', 'building')
    `),
  ).rejects.toThrow();

  await expect(
    db.execute(sql`
      INSERT INTO corpus_index_generations (family, generation, cluster, status)
      VALUES ('legislation', 'legislation_v2', 'quickwit_09', 'ready')
    `),
  ).rejects.toThrow();
});
