import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { Transaction } from "@/api/db/root";
import {
  corpusIndexGenerations,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import {
  beginCorpusIndexGenerationRebuildTx,
  completeCorpusIndexGenerationRebuildTx,
  deleteCorpusIndexGenerationProjectionBatchTx,
} from "@/api/lib/legal-search/corpus-index-generation-store";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const TARGET = {
  family: "legislation",
  generation: "legislation_v2",
} as const;
const ENTITY_ID = toSafeId<"legislationDocument">(
  "0198e331-e578-7000-8000-000000000901",
);
const INTENT_ID = toSafeId<"corpusIndexProjectionIntent">(
  "0198e331-e578-7000-8000-000000000902",
);
const LEASE_TOKEN = "0198e331-e578-7000-8000-000000000903";
const MIGRATION_URLS = [
  new URL(
    "../../../drizzle/20260825142000_corpus_index_projection_intents/migration.sql",
    import.meta.url,
  ),
  new URL(
    "../../../drizzle/20260825211300_corpus_projection_delete_guard_record/migration.sql",
    import.meta.url,
  ),
  new URL(
    "../../../drizzle/20260901060000_concurrent_corpus_projection_revision_fence/migration.sql",
    import.meta.url,
  ),
  new URL(
    "../../../drizzle/20260901070000_final_corpus_projection_rebuild/migration.sql",
    import.meta.url,
  ),
] as const;

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const runInTransaction = async <Value>(
  operation: (tx: Transaction) => Promise<Value>,
): Promise<Value> =>
  await db.transaction(
    async (tx) => await operation(asTestRaw<Transaction>(tx)),
  );

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  for (const migrationUrl of MIGRATION_URLS) {
    // oxlint-disable-next-line no-await-in-loop -- migration-owned functions and their triggers must install in production order
    const migration = await Bun.file(migrationUrl).text();
    for (const statement of migration.split("--> statement-breakpoint")) {
      const ddl = statement.trim();
      if (
        !ddl.includes("guard_corpus_index_projection_history_delete") &&
        !ddl.includes("corpus_index_projection_intents_delete_guard") &&
        !ddl.includes("corpus_index_projection_states_delete_guard") &&
        !ddl.includes("lock_corpus_projection_mutations_shared") &&
        !ddl.includes("lock_corpus_projection_mutations_exclusive") &&
        !ddl.includes("purge_rebuilding_corpus_index_projection_history")
      ) {
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- each trigger depends on the preceding migration-owned function
      await db.execute(sql.raw(ddl));
    }
  }
  await db.insert(corpusIndexGenerations).values({
    ...TARGET,
    cluster: "q09",
    manifestDigest: corpusIndexManifestDigest(
      CORPUS_INDEX_MANIFESTS.legislation_v2,
    ),
    status: "building",
  });
  await db.insert(corpusIndexProjectionStates).values({
    ...TARGET,
    entityId: ENTITY_ID,
    desiredAction: "erase",
    desiredEpoch: 1n,
  });
  await db.insert(corpusIndexProjectionIntents).values({
    id: INTENT_ID,
    ...TARGET,
    entityId: ENTITY_ID,
    epoch: 1n,
    fingerprint: "a".repeat(64),
    indexId: "legislation_v2_cze",
    status: "append_started",
    leaseToken: LEASE_TOKEN,
    leaseExpiresAt: new Date("2026-09-01T12:00:00.000Z"),
    appendStartedAt: new Date("2026-09-01T11:59:00.000Z"),
  });
});

afterAll(async () => {
  await client.close();
});

test("replaces only an empty non-serving generation", async () => {
  await runInTransaction(
    async (tx) => await beginCorpusIndexGenerationRebuildTx(tx, TARGET),
  );
  const prematureCompletion: unknown = await runInTransaction(
    async (tx) => await completeCorpusIndexGenerationRebuildTx(tx, TARGET),
  ).then(
    () => null,
    (error: unknown) => error,
  );
  expect(prematureCompletion).toMatchObject({
    message:
      "Corpus generation rebuild state is not empty: legislation/legislation_v2",
  });
  const unfencedDelete: unknown = await db
    .delete(corpusIndexProjectionStates)
    .where(eq(corpusIndexProjectionStates.entityId, ENTITY_ID))
    .then(
      () => null,
      (error: unknown) => error,
    );
  expect(unfencedDelete).toMatchObject({
    message: expect.stringContaining(
      "retiring corpus index projection history requires the rebuild fence",
    ),
  });
  expect(
    await runInTransaction(
      async (tx) =>
        await deleteCorpusIndexGenerationProjectionBatchTx(tx, TARGET, 1),
    ),
  ).toEqual({
    status: "deleted_history",
    stateCount: 1,
    intentCount: 1,
  });
  expect(
    await runInTransaction(
      async (tx) =>
        await deleteCorpusIndexGenerationProjectionBatchTx(tx, TARGET, 1),
    ),
  ).toEqual({ status: "empty", count: 0 });
  await runInTransaction(
    async (tx) => await completeCorpusIndexGenerationRebuildTx(tx, TARGET),
  );

  expect(
    await db
      .select({
        manifestDigest: corpusIndexGenerations.manifestDigest,
        status: corpusIndexGenerations.status,
      })
      .from(corpusIndexGenerations)
      .where(eq(corpusIndexGenerations.generation, TARGET.generation)),
  ).toEqual([
    {
      manifestDigest: corpusIndexManifestDigest(
        CORPUS_INDEX_MANIFESTS.legislation_v2,
      ),
      status: "building",
    },
  ]);
});
