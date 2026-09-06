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
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import {
  readAppliedCorpusProjectionCensusPageTx,
  repairAppliedCorpusProjectionDriftTx,
} from "@/api/lib/legal-search/corpus-index-projection-census-store";
import { corpusIndexAppendPublishDelayMs } from "@/api/lib/legal-search/corpus-index-projection-engine";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const TARGET = {
  family: "case_law",
  generation: "case_law_v5",
} as const;
const ENTITY_ID = "0198e331-e578-7000-8000-000000000401";
const REVISION = toSafeId<"corpusIndexProjectionIntent">(
  "0198e331-e578-7000-8000-000000000402",
);
const INDEX_ID = "case_law_v5_cs_sk";
const FINGERPRINT = "a".repeat(64);
const PUBLISH_DELAY_MS = corpusIndexAppendPublishDelayMs(
  CORPUS_INDEX_MANIFESTS.case_law_v5,
);

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const acceptAppendAt = async (acceptedAt: Date) =>
  await db
    .update(corpusIndexProjectionIntents)
    .set({
      appendStartedAt: acceptedAt,
      appendCommittedAt: acceptedAt,
      appliedAt: acceptedAt,
    })
    .where(eq(corpusIndexProjectionIntents.id, REVISION));

const censusCandidates = async () =>
  await db.transaction(
    async (tx) =>
      await readAppliedCorpusProjectionCensusPageTx(
        asTestRaw<Transaction>(tx),
        {
          ...TARGET,
          indexId: INDEX_ID,
          after: null,
          limit: 8,
        },
      ),
  );

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  await db.insert(corpusIndexGenerations).values({
    ...TARGET,
    cluster: "q09",
    manifestDigest: corpusIndexManifestDigest(
      CORPUS_INDEX_MANIFESTS.case_law_v5,
    ),
    status: "building",
  });
  await db.insert(corpusIndexProjectionIntents).values({
    id: REVISION,
    ...TARGET,
    entityId: ENTITY_ID,
    epoch: 1n,
    fingerprint: FINGERPRINT,
    indexId: INDEX_ID,
    status: "applied",
    appendStartedAt: new Date(),
    appendCommittedAt: new Date(),
    expectedDocumentCount: 1,
    appliedAt: new Date(),
  });
  await db.insert(corpusIndexProjectionStates).values({
    ...TARGET,
    entityId: ENTITY_ID,
    desiredAction: "upsert",
    desiredEpoch: 1n,
    desiredFingerprint: FINGERPRINT,
    desiredIndexId: INDEX_ID,
    appliedAction: "upsert",
    appliedEpoch: 1n,
    appliedRevision: REVISION,
    appliedFingerprint: FINGERPRINT,
    appliedIndexId: INDEX_ID,
    appliedAt: new Date(),
  });
});

afterAll(async () => {
  await client.close();
});

test("the applied census inspects a revision only once the engine published it", async () => {
  // A queued append is accepted before its documents are committed. Reading
  // one now would find no documents and repair a revision that is merely
  // late, so the census must not see it at all.
  expect((await censusCandidates()).candidates).toEqual([]);

  await acceptAppendAt(new Date(Date.now() - PUBLISH_DELAY_MS + 5000));
  expect((await censusCandidates()).candidates).toEqual([]);

  await acceptAppendAt(new Date(Date.now() - PUBLISH_DELAY_MS - 1000));
  expect((await censusCandidates()).candidates).toEqual([
    { entityId: ENTITY_ID, revision: REVISION, expectedDocumentCount: 1 },
  ]);
});

test("cleanup of an accepted append waits out the same publish barrier", async () => {
  const repairAt = new Date();
  const acceptedAt = new Date(repairAt.getTime() - 1000);
  await acceptAppendAt(acceptedAt);

  expect(
    await db.transaction(
      async (tx) =>
        await repairAppliedCorpusProjectionDriftTx(asTestRaw<Transaction>(tx), {
          ...TARGET,
          indexId: INDEX_ID,
          revisions: [REVISION],
          testNow: repairAt,
        }),
    ),
  ).toBe(1);

  // A delete issued inside the commit window never reaches documents the
  // engine has not published yet, and they would stay in the index forever.
  const [fenced] = await db
    .select({
      appendPublishBarrierAt:
        corpusIndexProjectionIntents.appendPublishBarrierAt,
      cleanupNotBefore: corpusIndexProjectionIntents.cleanupNotBefore,
    })
    .from(corpusIndexProjectionIntents)
    .where(eq(corpusIndexProjectionIntents.id, REVISION));
  const publishedAt = new Date(acceptedAt.getTime() + PUBLISH_DELAY_MS);
  expect(fenced?.appendPublishBarrierAt).toEqual(publishedAt);
  expect(fenced?.cleanupNotBefore).toEqual(publishedAt);
});
