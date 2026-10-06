import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import {
  corpusIndexGenerations,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
  legislationDocuments,
  legislationSources,
} from "@/api/db/schema";
import {
  rehydrateLegislationCandidates,
  readLegislationCandidateRows,
  legislationCandidateRowsStatement,
} from "@/api/handlers/legislation/search";
import { createSafeId } from "@/api/lib/branded-types";
import { createCorpusHitDispositionCounter } from "@/api/lib/legal-search/corpus-hit-telemetry";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { readCorpusIndexSearchPage } from "@/api/lib/legal-search/corpus-index-pagination";
import { RELEVANCE_ORDER } from "@/api/lib/legal-search/corpus-search-order";
import { corpusIndexId } from "@/api/lib/legal-search/index-naming";
import type {
  LegislationReadDb,
  LegislationReadTransaction,
} from "@/api/lib/legislation-public-read-db";
import { installCorpusDispositionScan } from "@/api/tests/helpers/corpus-disposition-scan";
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
const secondProjectedId = createSafeId<"legislationDocument">();
const secondProjectedIntentId = createSafeId<"corpusIndexProjectionIntent">();
const projectedId = createSafeId<"legislationDocument">();
const queuedId = createSafeId<"legislationDocument">();
const movedId = createSafeId<"legislationDocument">();
const withdrawnId = createSafeId<"legislationDocument">();
const projectedIntentId = createSafeId<"corpusIndexProjectionIntent">();
const queuedIntentId = createSafeId<"corpusIndexProjectionIntent">();
const movedIntentId = createSafeId<"corpusIndexProjectionIntent">();
const withdrawnIntentId = createSafeId<"corpusIndexProjectionIntent">();

/** Same budget as the schema push: an embedded Postgres is not fast. */
const DB_TEST_TIMEOUT_MS = 120_000;

let client: PGlite;
let legislationDb: LegislationReadDb;
let reads = 0;
beforeEach(() => {
  reads = 0;
});

const candidatesOf = (...ids: string[]) => ids.map((id) => ({ id, score: 1 }));

beforeAll(
  async () => {
    client = await createTestPglite();
    const db = drizzle({ client });
    legislationDb = async <T>(
      fn: (tx: LegislationReadTransaction) => Promise<T>,
    ) => {
      reads += 1;
      return await withPublicLawReaderRole(db, async (roleTx) => {
        // SAFETY: the role transaction supplies the select surface the reads use.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test handle stands in for a transaction
        const tx = roleTx as unknown as LegislationReadTransaction;
        return await fn(tx);
      });
    };

    await db
      .insert(legislationSources)
      .values([
        { id: sourceId, adapterKey: "statutes-open", name: "Open statutes" },
      ]);

    // The document carries nothing that says what an index holds; that is
    // stated by its projection state alone.
    await db.insert(legislationDocuments).values(
      [projectedId, queuedId, movedId, unheldId, secondProjectedId].map(
        (id, index) => ({
          id,
          sourceId,
          eli: `CZ/2020/${id === secondProjectedId ? 6 : index + 1}`,
          title: `Projected act ${index + 1}`,
          country: "CZE",
          language: "cs",
          contentHash: `hash-${index}`,
        }),
      ),
    );
    // Withdrawn by its publisher; nothing has erased it from the index yet.
    await db.insert(legislationDocuments).values({
      id: withdrawnId,
      sourceId,
      eli: "CZ/2020/5",
      title: "Withdrawn act",
      country: "CZE",
      language: "cs",
      contentHash: "hash-withdrawn",
      windowDisposition: "withdrawn",
      windowDispositionBasis: "publisher-unlisted",
    });

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
          id: secondProjectedIntentId,
          entityId: secondProjectedId,
          indexId: PROJECTED_INDEX_ID,
        },
        {
          id: projectedIntentId,
          entityId: projectedId,
          indexId: PROJECTED_INDEX_ID,
        },
        { id: queuedIntentId, entityId: queuedId, indexId: PROJECTED_INDEX_ID },
        { id: movedIntentId, entityId: movedId, indexId: OTHER_INDEX_ID },
        {
          id: withdrawnIntentId,
          entityId: withdrawnId,
          indexId: PROJECTED_INDEX_ID,
        },
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
      {
        family: "legislation",
        generation: PROJECTED_GENERATION,
        entityId: secondProjectedId,
        desiredAction: "upsert",
        desiredEpoch: 1n,
        desiredFingerprint: APPLIED_FINGERPRINT,
        desiredIndexId: PROJECTED_INDEX_ID,
        appliedAction: "upsert",
        appliedEpoch: 1n,
        appliedRevision: secondProjectedIntentId,
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
      // Converged on an upsert in the routed index, exactly as the first
      // document is: the erase its withdrawal calls for has not been asked
      // of the index yet, so the engine still holds and returns it.
      {
        family: "legislation",
        generation: PROJECTED_GENERATION,
        entityId: withdrawnId,
        desiredAction: "upsert",
        desiredEpoch: 1n,
        desiredFingerprint: APPLIED_FINGERPRINT,
        desiredIndexId: PROJECTED_INDEX_ID,
        appliedAction: "upsert",
        appliedEpoch: 1n,
        appliedRevision: withdrawnIntentId,
        appliedFingerprint: APPLIED_FINGERPRINT,
        appliedIndexId: PROJECTED_INDEX_ID,
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

test("a withdrawn version is dropped while its erase is still pending", async () => {
  // The first document holds the same converged state in the same index, so
  // the projection state alone would admit both: only the withdrawal differs.
  const result = await rehydrateLegislationCandidates({
    body: { query: "smlouva" },
    candidates: candidatesOf(withdrawnId, projectedId),
    generation: PROJECTED_GENERATION,
    legislationDb,
  });

  expect(result.ranked.map((hit) => hit.id)).toEqual([projectedId]);
  expect([...result.context.byId.keys()]).toEqual([projectedId]);
});

test("rehydration accounts for exclusions and absent canonical rows in one read", async () => {
  const hitDispositions = createCorpusHitDispositionCounter();
  const missingId = createSafeId<"legislationDocument">();
  const result = await rehydrateLegislationCandidates({
    body: { query: "smlouva" },
    legislationDb,
    hitDispositions,
    generation: PROJECTED_GENERATION,
    candidates: candidatesOf(
      projectedId,
      queuedId,
      movedId,
      unheldId,
      withdrawnId,
      missingId,
    ),
  });
  expect(result.ranked.map((hit) => hit.id)).toEqual([projectedId]);
  expect([...result.context.byId.keys()]).toEqual([projectedId]);
  expect(hitDispositions.snapshot()).toEqual({
    malformed: 0,
    excluded: 4,
    drift: 1,
  });
  expect(reads).toBe(1);
});

test("the legislation read separates eligible content from id-only dispositions", async () => {
  const missingId = createSafeId<"legislationDocument">();
  await legislationDb(async (tx) => {
    const options = {
      body: { query: "smlouva" },
      generation: PROJECTED_GENERATION,
      ids: [projectedId, withdrawnId, queuedId, missingId],
    };
    const read = await readLegislationCandidateRows(tx, options);
    expect(read.rows.map((row) => row.id)).toEqual([projectedId]);
    expect(read.dispositions).toEqual(
      expect.arrayContaining([
        { id: withdrawnId, type: "excluded" },
        { id: queuedId, type: "excluded" },
        { id: missingId, type: "drift" },
      ]),
    );
    expect(read.dispositions).toHaveLength(3);
    expect(JSON.stringify(read)).not.toContain("Withdrawn act");
    const records = await legislationCandidateRowsStatement(tx, {
      ...options,
      ids: [withdrawnId, queuedId],
    });
    expect(records).toHaveLength(2);
    expect(records).toEqual(
      expect.arrayContaining([
        { id: withdrawnId, row: null },
        { id: queuedId, row: null },
      ]),
    );
    await tx.execute(sql`SET LOCAL enable_seqscan = off`);
    const statement = legislationCandidateRowsStatement(tx, options);
    const plan = JSON.stringify(
      await tx.execute(sql`EXPLAIN (COSTS OFF) ${statement.getSQL()}`),
    );
    expect(plan).toMatch(
      /Index(?: Only)? Scan using legislation_documents_pkey|Bitmap Index Scan on legislation_documents_pkey/u,
    );
  });
});

test("legislation scan counts retained omissions once as eligible candidates grow", async () => {
  const hitDispositions = createCorpusHitDispositionCounter();
  const missingId = createSafeId<"legislationDocument">();
  const eligibleIds = [projectedId, secondProjectedId];
  const restoreFetch = installCorpusDispositionScan([
    withdrawnId,
    missingId,
    ...eligibleIds,
  ]);
  const candidateCounts: number[] = [];
  const eligibleCounts: number[] = [];
  try {
    const page = await readCorpusIndexSearchPage({
      observer: "unobserved",
      cluster: "q09",
      indexId: PROJECTED_INDEX_ID,
      query: "text:fixture",
      limit: 40,
      order: RELEVANCE_ORDER,
      parsedCursor: null,
      hitDispositions,
      rankingMode: "off",
      snippetFields: ["text"],
      extractId: (hit) =>
        typeof hit["document_id"] === "string" ? hit["document_id"] : null,
      extractSnippet: () => null,
      unseenScoreUpperBound: () => 0,
      rankCandidates: async (candidates) => {
        candidateCounts.push(candidates.length);
        const result = await rehydrateLegislationCandidates({
          body: { query: "smlouva" },
          generation: PROJECTED_GENERATION,
          legislationDb,
          hitDispositions,
          candidates,
          namedWorks: [],
        });
        eligibleCounts.push(result.ranked.length);
        return result;
      },
    });
    expect(page.scan.rounds).toBe(3);
    expect(candidateCounts).toEqual([2, 3, 4]);
    expect(eligibleCounts).toEqual([0, 1, 2]);
    expect(hitDispositions.snapshot()).toEqual({
      malformed: 0,
      excluded: 1,
      drift: 1,
    });
    expect(reads).toBe(3);
  } finally {
    restoreFetch();
  }
});
