import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/pglite";

import {
  corpusIndexGenerations,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
  legislationDocuments,
  legislationSources,
} from "@/api/db/schema";
import { rehydrateLegislationCandidates } from "@/api/handlers/legislation/search";
import { createSafeId } from "@/api/lib/branded-types";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { corpusIndexId } from "@/api/lib/legal-search/index-naming";
import type {
  LegislationReadDb,
  LegislationReadTransaction,
} from "@/api/lib/legislation-public-read-db";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

/**
 * Rehydration decides which corpus hits a legislation page may serve. A
 * generation states desired and applied per document, and only a row where
 * the two agree, in the index the document's jurisdiction routes to, may
 * stand for a hit. These tests hold that reading.
 */

const PROJECTED_GENERATION = "legislation_v2";
const PROJECTED_INDEX_ID = corpusIndexId(PROJECTED_GENERATION, "CZE");
const OTHER_INDEX_ID = corpusIndexId(PROJECTED_GENERATION, "SVK");
const APPLIED_FINGERPRINT = "a".repeat(64);
const DESIRED_FINGERPRINT = "b".repeat(64);

const sourceId = createSafeId<"legislationSource">();
const unheldId = createSafeId<"legislationDocument">();
const projectedId = createSafeId<"legislationDocument">();
const queuedId = createSafeId<"legislationDocument">();
const movedId = createSafeId<"legislationDocument">();
const projectedIntentId = createSafeId<"corpusIndexProjectionIntent">();
const queuedIntentId = createSafeId<"corpusIndexProjectionIntent">();
const movedIntentId = createSafeId<"corpusIndexProjectionIntent">();

/** Same budget as the schema push: an embedded Postgres is not fast. */
const DB_TEST_TIMEOUT_MS = 120_000;

let client: PGlite;
let legislationDb: LegislationReadDb;

const candidatesOf = (...ids: string[]) => ids.map((id) => ({ id, score: 1 }));

beforeAll(
  async () => {
    client = await createTestPglite();
    const db = drizzle({ client });
    legislationDb = async <T>(
      fn: (tx: LegislationReadTransaction) => Promise<T>,
    ) =>
      await withPublicLawReaderRole(db, async (roleTx) => {
        // SAFETY: the role transaction supplies the select surface the reads use.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test handle stands in for a transaction
        const tx = roleTx as unknown as LegislationReadTransaction;
        return await fn(tx);
      });

    await db
      .insert(legislationSources)
      .values([
        { id: sourceId, adapterKey: "statutes-open", name: "Open statutes" },
      ]);

    // The document carries nothing that says what an index holds; that is
    // stated by its projection state alone.
    await db.insert(legislationDocuments).values(
      [projectedId, queuedId, movedId, unheldId].map((id, index) => ({
        id,
        sourceId,
        eli: `CZ/2020/${index + 1}`,
        title: `Projected act ${index + 1}`,
        country: "CZE",
        language: "cs",
        contentHash: `hash-${index}`,
      })),
    );

    await db.insert(corpusIndexGenerations).values({
      family: "legislation",
      generation: PROJECTED_GENERATION,
      cluster: "q09",
      manifestDigest: corpusIndexManifestDigest(
        CORPUS_INDEX_MANIFESTS[PROJECTED_GENERATION],
      ),
      status: "building",
    });

    await db.insert(corpusIndexProjectionIntents).values(
      [
        {
          id: projectedIntentId,
          entityId: projectedId,
          indexId: PROJECTED_INDEX_ID,
        },
        { id: queuedIntentId, entityId: queuedId, indexId: PROJECTED_INDEX_ID },
        { id: movedIntentId, entityId: movedId, indexId: OTHER_INDEX_ID },
      ].map(({ id, entityId, indexId }) => ({
        id,
        family: "legislation" as const,
        generation: PROJECTED_GENERATION,
        entityId,
        epoch: 1n,
        fingerprint: APPLIED_FINGERPRINT,
        indexId,
        status: "applied" as const,
        appendStartedAt: new Date(),
        appendCommittedAt: new Date(),
        expectedDocumentCount: 1,
        appliedAt: new Date(),
      })),
    );

    await db.insert(corpusIndexProjectionStates).values([
      {
        family: "legislation",
        generation: PROJECTED_GENERATION,
        entityId: projectedId,
        desiredAction: "upsert",
        desiredEpoch: 1n,
        desiredFingerprint: APPLIED_FINGERPRINT,
        desiredIndexId: PROJECTED_INDEX_ID,
        appliedAction: "upsert",
        appliedEpoch: 1n,
        appliedRevision: projectedIntentId,
        appliedFingerprint: APPLIED_FINGERPRINT,
        appliedIndexId: PROJECTED_INDEX_ID,
        appliedAt: new Date(),
      },
      // The applied revision is behind a queued content change, so what the
      // engine holds for this document is not what the generation wants.
      {
        family: "legislation",
        generation: PROJECTED_GENERATION,
        entityId: queuedId,
        desiredAction: "upsert",
        desiredEpoch: 2n,
        desiredFingerprint: DESIRED_FINGERPRINT,
        desiredIndexId: PROJECTED_INDEX_ID,
        appliedAction: "upsert",
        appliedEpoch: 1n,
        appliedRevision: queuedIntentId,
        appliedFingerprint: APPLIED_FINGERPRINT,
        appliedIndexId: PROJECTED_INDEX_ID,
        appliedAt: new Date(),
      },
      // Converged, but on the index of a jurisdiction the document no longer
      // carries: the copy that would answer sits in another index entirely.
      {
        family: "legislation",
        generation: PROJECTED_GENERATION,
        entityId: movedId,
        desiredAction: "upsert",
        desiredEpoch: 1n,
        desiredFingerprint: APPLIED_FINGERPRINT,
        desiredIndexId: OTHER_INDEX_ID,
        appliedAction: "upsert",
        appliedEpoch: 1n,
        appliedRevision: movedIntentId,
        appliedFingerprint: APPLIED_FINGERPRINT,
        appliedIndexId: OTHER_INDEX_ID,
        appliedAt: new Date(),
      },
    ]);
  },
  { timeout: DB_TEST_TIMEOUT_MS },
);

afterAll(async () => {
  await client.close();
});

test("a generation admits exactly what its projection state holds", async () => {
  const result = await rehydrateLegislationCandidates({
    body: { query: "smlouva" },
    candidates: candidatesOf(projectedId, queuedId, movedId, unheldId),
    generation: PROJECTED_GENERATION,
    legislationDb,
  });

  // Applied equals desired for the first document, in the index this
  // generation routes its jurisdiction to. The second still owes the index a
  // mutation, the third is converged on another jurisdiction's index, and the
  // fourth has no state row in this generation at all.
  expect(result.ranked.map((hit) => hit.id)).toEqual([projectedId]);
  expect([...result.context.byId.keys()]).toEqual([projectedId]);
});

test("the request filters still bind on the projection state", async () => {
  const result = await rehydrateLegislationCandidates({
    body: { jurisdiction: "SVK", query: "smlouva" },
    candidates: candidatesOf(projectedId),
    generation: PROJECTED_GENERATION,
    legislationDb,
  });

  expect(result.ranked).toEqual([]);
});
