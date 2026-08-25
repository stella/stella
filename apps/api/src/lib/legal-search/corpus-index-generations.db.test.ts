import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { corpusIndexGenerations } from "@/api/db/schema";
import { createTestPglite } from "@/api/tests/pglite-test-db";

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
const MANIFEST_DIGEST = "a".repeat(64);
const MIGRATION_URL = new URL(
  "../../../drizzle/20260825137100_corpus_index_generations/migration.sql",
  import.meta.url,
);

const errorMessageChain = (error: unknown): string => {
  const messages: string[] = [];
  let current = error;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join(" | ");
};

const rejectionMessage = async (run: Promise<unknown>): Promise<string> =>
  await run.then(
    () => "no rejection",
    (error: unknown) => errorMessageChain(error),
  );

beforeAll(
  async () => {
    client = await createTestPglite();
    db = drizzle({ client });

    // drizzle-kit reconstructs tables and constraints for the lightweight
    // PGlite snapshot, but triggers exist only in committed migrations. Apply
    // the exact migration-owned function and trigger so this suite exercises
    // the production immutability boundary rather than a test-only copy.
    const migration = await Bun.file(MIGRATION_URL).text();
    for (const statement of migration.split("--> statement-breakpoint")) {
      const ddl = statement.trim();
      if (
        !/(?:^|\n)\s*CREATE (?:OR REPLACE )?FUNCTION\b/u.test(ddl) &&
        !/(?:^|\n)\s*CREATE TRIGGER\b/u.test(ddl)
      ) {
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- the trigger depends on the function created immediately before it
      await db.execute(sql.raw(ddl));
    }
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

  expect(
    await rejectionMessage(
      db
        .insert(corpusIndexGenerations)
        .values({
          cluster: "q09",
          family: "case_law",
          generation: "case_law_v6",
          manifestDigest: MANIFEST_DIGEST,
          status: "serving",
        })
        .execute(),
    ),
  ).toContain("corpus_index_generations_serving_family_uidx");

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
  expect(
    await rejectionMessage(
      db.execute(sql`
        INSERT INTO corpus_index_generations (family, generation, cluster, manifest_digest, status)
        VALUES ('case_law', 'legislation_v2', 'q09', ${MANIFEST_DIGEST}, 'building')
      `),
    ),
  ).toContain("corpus_index_generations_name_matches_family");

  expect(
    await rejectionMessage(
      db.execute(sql`
        INSERT INTO corpus_index_generations (family, generation, cluster, manifest_digest, status)
        VALUES ('legislation', 'legislation_v2', 'quickwit_10', ${MANIFEST_DIGEST}, 'building')
      `),
    ),
  ).toContain("corpus_index_generations_cluster_values");

  expect(
    await rejectionMessage(
      db.execute(sql`
        INSERT INTO corpus_index_generations (family, generation, cluster, manifest_digest, status)
        VALUES ('legislation', 'legislation_v2', 'q09', ${MANIFEST_DIGEST}, 'ready')
      `),
    ),
  ).toContain("corpus_index_generations_status_values");

  expect(
    await rejectionMessage(
      db.execute(sql`
        INSERT INTO corpus_index_generations (family, generation, cluster, manifest_digest, status)
        VALUES ('case_law', 'case_law_v11111111111111111111111111111111', 'q09', ${MANIFEST_DIGEST}, 'building')
      `),
    ),
  ).toContain("value too long for type character varying(32)");

  expect(
    await rejectionMessage(
      db.execute(sql`
        INSERT INTO corpus_index_generations (family, generation, cluster, manifest_digest, status)
        VALUES ('case_law', 'case_law_v8', 'q09', 'not-a-digest', 'building')
      `),
    ),
  ).toContain("corpus_index_generations_manifest_digest_shape");
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

  expect(
    await rejectionMessage(
      db.execute(sql`
        UPDATE corpus_index_generations
        SET cluster = 'q08'
        WHERE family = 'case_law' AND generation = 'case_law_v7'
      `),
    ),
  ).toContain("corpus index generation identity is immutable");

  expect(
    await rejectionMessage(
      db.execute(sql`
        UPDATE corpus_index_generations
        SET manifest_digest = ${"b".repeat(64)}
        WHERE family = 'case_law' AND generation = 'case_law_v7'
      `),
    ),
  ).toContain("corpus index generation identity is immutable");
});
