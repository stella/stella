import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
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
    status: "cancelled",
    cancelledAt: new Date(),
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
  expect(
    await runInTransaction(
      async (tx) =>
        await deleteCorpusIndexGenerationProjectionBatchTx(tx, TARGET, 1),
    ),
  ).toEqual({ status: "deleted_states", count: 1 });
  expect(
    await runInTransaction(
      async (tx) =>
        await deleteCorpusIndexGenerationProjectionBatchTx(tx, TARGET, 1),
    ),
  ).toEqual({ status: "deleted_intents", count: 1 });
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
