import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { corpusIndexGenerations } from "@/api/db/schema";
import { createTestPglite } from "@/api/tests/pglite-test-db";

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
const MANIFEST_DIGEST = "a".repeat(64);

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
      cluster: "q08",
      family: "case_law",
      generation: "case_law_v2",
      manifestDigest: MANIFEST_DIGEST,
      status: "serving",
    },
    {
      cluster: "q09",
      family: "case_law",
      generation: "case_law_v5",
      manifestDigest: MANIFEST_DIGEST,
      status: "building",
    },
    {
      cluster: "q08",
      family: "legislation",
      generation: "legislation_v1",
      manifestDigest: MANIFEST_DIGEST,
      status: "serving",
    },
  ]);

  await expect(
    db.insert(corpusIndexGenerations).values({
      cluster: "q09",
      family: "case_law",
      generation: "case_law_v6",
      manifestDigest: MANIFEST_DIGEST,
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
      cluster: "q08",
      family: "case_law",
      generation: "case_law_v2",
    },
    {
      cluster: "q08",
      family: "legislation",
      generation: "legislation_v1",
    },
  ]);
});

test("database constraints reject drift outside the TypeScript contract", async () => {
  await expect(
    db.execute(sql`
      INSERT INTO corpus_index_generations (family, generation, cluster, manifest_digest, status)
      VALUES ('case_law', 'legislation_v2', 'q09', ${MANIFEST_DIGEST}, 'building')
    `),
  ).rejects.toThrow();

  await expect(
    db.execute(sql`
      INSERT INTO corpus_index_generations (family, generation, cluster, manifest_digest, status)
      VALUES ('legislation', 'legislation_v2', 'quickwit_10', ${MANIFEST_DIGEST}, 'building')
    `),
  ).rejects.toThrow();

  await expect(
    db.execute(sql`
      INSERT INTO corpus_index_generations (family, generation, cluster, manifest_digest, status)
      VALUES ('legislation', 'legislation_v2', 'q09', ${MANIFEST_DIGEST}, 'ready')
    `),
  ).rejects.toThrow();

  await expect(
    db.execute(sql`
      INSERT INTO corpus_index_generations (family, generation, cluster, manifest_digest, status)
      VALUES ('case_law', 'case_law_v11111111111111111111111111111111', 'q09', ${MANIFEST_DIGEST}, 'building')
    `),
  ).rejects.toThrow();

  await expect(
    db.execute(sql`
      INSERT INTO corpus_index_generations (family, generation, cluster, manifest_digest, status)
      VALUES ('case_law', 'case_law_v8', 'q09', 'not-a-digest', 'building')
    `),
  ).rejects.toThrow();
});

test("generation identity cannot be retargeted after registration", async () => {
  await db.insert(corpusIndexGenerations).values({
    cluster: "q09",
    family: "case_law",
    generation: "case_law_v7",
    manifestDigest: MANIFEST_DIGEST,
    status: "building",
  });

  await db
    .update(corpusIndexGenerations)
    .set({ status: "retiring" })
    .where(eq(corpusIndexGenerations.generation, "case_law_v7"));

  await expect(
    db.execute(sql`
      UPDATE corpus_index_generations
      SET cluster = 'q08'
      WHERE family = 'case_law' AND generation = 'case_law_v7'
    `),
  ).rejects.toThrow("corpus index generation identity is immutable");

  await expect(
    db.execute(sql`
      UPDATE corpus_index_generations
      SET manifest_digest = ${"b".repeat(64)}
      WHERE family = 'case_law' AND generation = 'case_law_v7'
    `),
  ).rejects.toThrow("corpus index generation identity is immutable");
});
