import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
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
import { readCorpusIndexProjectionConvergenceTx } from "@/api/lib/legal-search/corpus-index-projection-convergence";
import { corpusIndexAppendPublishDelayMs } from "@/api/lib/legal-search/corpus-index-projection-engine";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const TARGET = {
  family: "case_law",
  generation: "case_law_v5",
} as const;
const ENTITY_ID = "0198e331-e578-7000-8000-000000000301";
const APPLIED_INTENT_ID = toSafeId<"corpusIndexProjectionIntent">(
  "0198e331-e578-7000-8000-000000000302",
);
const CLEANUP_INTENT_ID = toSafeId<"corpusIndexProjectionIntent">(
  "0198e331-e578-7000-8000-000000000303",
);
const ORPHAN_APPLIED_INTENT_ID = toSafeId<"corpusIndexProjectionIntent">(
  "0198e331-e578-7000-8000-000000000304",
);
const CONVERGED_ENTITY_ID = "0198e331-e578-7000-8000-000000000309";
const CONVERGED_INTENT_ID = toSafeId<"corpusIndexProjectionIntent">(
  "0198e331-e578-7000-8000-000000000310",
);
const ERASING_ENTITY_ID = "0198e331-e578-7000-8000-000000000305";
const SETTLED_INTENT_ID = toSafeId<"corpusIndexProjectionIntent">(
  "0198e331-e578-7000-8000-000000000306",
);
const UNREFERENCED_ENTITY_ID = "0198e331-e578-7000-8000-000000000307";
const UNREFERENCED_INTENT_ID = toSafeId<"corpusIndexProjectionIntent">(
  "0198e331-e578-7000-8000-000000000308",
);
const INDEX_ID = "case_law_v5_cs_sk";
const FINGERPRINT = "a".repeat(64);
const ERASING_FINGERPRINT = "d".repeat(64);
const CONVERGED_FINGERPRINT = "e".repeat(64);
const NOW = new Date("2026-08-26T00:00:00.000Z");

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const readStatus = async () =>
  await db.transaction(
    async (tx) =>
      await readCorpusIndexProjectionConvergenceTx(
        asTestRaw<Transaction>(tx),
        TARGET,
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
});

afterAll(async () => {
  await client.close();
});

test("the launch probe requires populated current state before census", async () => {
  expect(await readStatus()).toBe("empty");

  await db.insert(corpusIndexProjectionStates).values({
    ...TARGET,
    entityId: ENTITY_ID,
    desiredAction: "upsert",
    desiredEpoch: 1n,
    desiredFingerprint: FINGERPRINT,
    desiredIndexId: INDEX_ID,
  });
  expect(await readStatus()).toBe("pending");

  await db
    .update(corpusIndexProjectionStates)
    .set({
      workStatus: "blocked",
      failureAttempts: 1,
      lastFailureKind: "payload_unavailable",
      lastFailureMessage: "fixture payload is unavailable",
    })
    .where(
      and(
        eq(corpusIndexProjectionStates.family, TARGET.family),
        eq(corpusIndexProjectionStates.generation, TARGET.generation),
        eq(corpusIndexProjectionStates.entityId, ENTITY_ID),
      ),
    );
  expect(await readStatus()).toBe("blocked");

  await db.insert(corpusIndexProjectionIntents).values({
    id: APPLIED_INTENT_ID,
    ...TARGET,
    entityId: ENTITY_ID,
    epoch: 1n,
    fingerprint: FINGERPRINT,
    indexId: INDEX_ID,
    status: "applied",
    appendStartedAt: NOW,
    appendCommittedAt: NOW,
    expectedDocumentCount: 1,
    appliedAt: NOW,
  });
  await db
    .update(corpusIndexProjectionStates)
    .set({
      workStatus: "eligible",
      failureAttempts: 0,
      lastFailureKind: null,
      lastFailureMessage: null,
      appliedAction: "upsert",
      appliedEpoch: 1n,
      appliedRevision: APPLIED_INTENT_ID,
      appliedFingerprint: FINGERPRINT,
      appliedIndexId: INDEX_ID,
      appliedAt: NOW,
    })
    .where(
      and(
        eq(corpusIndexProjectionStates.family, TARGET.family),
        eq(corpusIndexProjectionStates.generation, TARGET.generation),
        eq(corpusIndexProjectionStates.entityId, ENTITY_ID),
      ),
    );
  expect(await readStatus()).toBe("ready_for_census");

  await db
    .update(corpusIndexProjectionStates)
    .set({ workStatus: "repair_scheduled" })
    .where(eq(corpusIndexProjectionStates.entityId, ENTITY_ID));
  expect(await readStatus()).toBe("pending");
  await db
    .update(corpusIndexProjectionStates)
    .set({ workStatus: "eligible" })
    .where(eq(corpusIndexProjectionStates.entityId, ENTITY_ID));
  expect(await readStatus()).toBe("ready_for_census");

  await db.insert(corpusIndexProjectionIntents).values({
    id: ORPHAN_APPLIED_INTENT_ID,
    ...TARGET,
    entityId: ENTITY_ID,
    epoch: 2n,
    fingerprint: "b".repeat(64),
    indexId: INDEX_ID,
    status: "applied",
    appendStartedAt: NOW,
    appendCommittedAt: NOW,
    expectedDocumentCount: 1,
    appliedAt: NOW,
  });
  expect(await readStatus()).toBe("intent_outstanding");
  await db
    .delete(corpusIndexProjectionIntents)
    .where(eq(corpusIndexProjectionIntents.id, ORPHAN_APPLIED_INTENT_ID));
  expect(await readStatus()).toBe("ready_for_census");

  await db.insert(corpusIndexProjectionIntents).values({
    id: CLEANUP_INTENT_ID,
    ...TARGET,
    entityId: ENTITY_ID,
    epoch: 2n,
    fingerprint: "b".repeat(64),
    indexId: INDEX_ID,
    status: "cleanup_pending",
    appendStartedAt: NOW,
    appendPublishBarrierAt: NOW,
    cleanupNotBefore: NOW,
  });
  expect(await readStatus()).toBe("intent_outstanding");
});

test("the launch probe waits out the engine publish delay", async () => {
  await db
    .delete(corpusIndexProjectionIntents)
    .where(eq(corpusIndexProjectionIntents.id, CLEANUP_INTENT_ID));
  expect(await readStatus()).toBe("ready_for_census");

  const acceptedAt = new Date();
  await db
    .update(corpusIndexProjectionIntents)
    .set({
      appendStartedAt: acceptedAt,
      appendCommittedAt: acceptedAt,
      appliedAt: acceptedAt,
    })
    .where(eq(corpusIndexProjectionIntents.id, APPLIED_INTENT_ID));
  // Every revision is applied, but a queued one is not searchable yet. A
  // census run now would inspect a strict subset and still read as complete,
  // which is a proof of nothing.
  expect(await readStatus()).toBe("publish_pending");

  const published = new Date(
    Date.now() -
      corpusIndexAppendPublishDelayMs(CORPUS_INDEX_MANIFESTS.case_law_v5) -
      1000,
  );
  await db
    .update(corpusIndexProjectionIntents)
    .set({
      appendStartedAt: published,
      appendCommittedAt: published,
      appliedAt: published,
    })
    .where(eq(corpusIndexProjectionIntents.id, APPLIED_INTENT_ID));
  expect(await readStatus()).toBe("ready_for_census");
});

// An entity whose erasure is still settling keeps its exact revision pointer
// until every revision of that entity is proven deleted, so its state names a
// revision that is no longer `applied`. Counting applied revisions against
// referenced ones must not let that reference offset an unreferenced applied
// revision elsewhere in the generation and read as convergence.
test("a settling erasure cannot offset an unreferenced applied revision", async () => {
  // Its own converged entity, so the case holds whether this test runs alone
  // or after the ones above.
  await db.insert(corpusIndexProjectionIntents).values({
    id: CONVERGED_INTENT_ID,
    ...TARGET,
    entityId: CONVERGED_ENTITY_ID,
    epoch: 1n,
    fingerprint: CONVERGED_FINGERPRINT,
    indexId: INDEX_ID,
    status: "applied",
    appendStartedAt: NOW,
    appendCommittedAt: NOW,
    expectedDocumentCount: 1,
    appliedAt: NOW,
  });
  await db.insert(corpusIndexProjectionStates).values({
    ...TARGET,
    entityId: CONVERGED_ENTITY_ID,
    desiredAction: "upsert",
    desiredEpoch: 1n,
    desiredFingerprint: CONVERGED_FINGERPRINT,
    desiredIndexId: INDEX_ID,
    appliedAction: "upsert",
    appliedEpoch: 1n,
    appliedRevision: CONVERGED_INTENT_ID,
    appliedFingerprint: CONVERGED_FINGERPRINT,
    appliedIndexId: INDEX_ID,
    appliedAt: NOW,
  });
  expect(await readStatus()).toBe("ready_for_census");

  await db.insert(corpusIndexProjectionIntents).values({
    id: SETTLED_INTENT_ID,
    ...TARGET,
    entityId: ERASING_ENTITY_ID,
    epoch: 1n,
    fingerprint: ERASING_FINGERPRINT,
    indexId: INDEX_ID,
    status: "settled",
    appendStartedAt: NOW,
    appendCommittedAt: NOW,
    appendPublishBarrierAt: NOW,
    cleanupNotBefore: NOW,
    cleanupStartedAt: NOW,
    deleteOpstamp: 42n,
    deleteTaskCreatedAt: NOW,
    settledAt: NOW,
  });
  await db.insert(corpusIndexProjectionStates).values({
    ...TARGET,
    entityId: ERASING_ENTITY_ID,
    desiredAction: "erase",
    desiredEpoch: 2n,
    appliedAction: "upsert",
    appliedEpoch: 1n,
    appliedRevision: SETTLED_INTENT_ID,
    appliedFingerprint: ERASING_FINGERPRINT,
    appliedIndexId: INDEX_ID,
    appliedAt: NOW,
  });
  await db.insert(corpusIndexProjectionIntents).values({
    id: UNREFERENCED_INTENT_ID,
    ...TARGET,
    entityId: UNREFERENCED_ENTITY_ID,
    epoch: 1n,
    fingerprint: "c".repeat(64),
    indexId: INDEX_ID,
    status: "applied",
    appendStartedAt: NOW,
    appendCommittedAt: NOW,
    expectedDocumentCount: 1,
    appliedAt: NOW,
  });
  // Two applied revisions and two referenced ones, and the census still waits:
  // the erasure owes the index an exact action.
  expect(await readStatus()).toBe("pending");

  await db
    .delete(corpusIndexProjectionStates)
    .where(eq(corpusIndexProjectionStates.entityId, ERASING_ENTITY_ID));
  await db
    .delete(corpusIndexProjectionIntents)
    .where(eq(corpusIndexProjectionIntents.id, SETTLED_INTENT_ID));
  expect(await readStatus()).toBe("intent_outstanding");

  await db
    .delete(corpusIndexProjectionIntents)
    .where(eq(corpusIndexProjectionIntents.id, UNREFERENCED_INTENT_ID));
  expect(await readStatus()).toBe("ready_for_census");

  await db
    .delete(corpusIndexProjectionStates)
    .where(eq(corpusIndexProjectionStates.entityId, CONVERGED_ENTITY_ID));
  await db
    .delete(corpusIndexProjectionIntents)
    .where(eq(corpusIndexProjectionIntents.id, CONVERGED_INTENT_ID));
});
