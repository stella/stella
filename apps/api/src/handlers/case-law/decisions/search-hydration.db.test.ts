import type { PGlite } from "@electric-sql/pglite";
import { panic, Result } from "better-result";
import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import {
  caseLawDecisions,
  caseLawSources,
  corpusIndexGenerations,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import { courtWeightMapFromSeed } from "@/api/handlers/case-law/court-weight-seed";
import {
  candidateDecisionRowsQuery,
  candidateDecisionRowsStatement,
  pageDecisionRowsQuery,
  pageDecisionRowsStatement,
  readCaseLawPageDecisionRows,
  rehydrateCaseLawCandidates,
  searchCorpusIndexDecisions,
} from "@/api/handlers/case-law/decisions/search";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { resetPublicCaseLawConfigForTesting } from "@/api/lib/case-law/public-case-law-config";
import { createCorpusHitDispositionCounter } from "@/api/lib/legal-search/corpus-hit-telemetry";
import { getCorpusIndexClient } from "@/api/lib/legal-search/corpus-index-client";
import { corpusIndexReadTarget } from "@/api/lib/legal-search/corpus-index-group-contract";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { readCorpusIndexSearchPage } from "@/api/lib/legal-search/corpus-index-pagination";
import {
  rankCorpusIndexProviderCandidates,
  rehydrateCorpusIndexProviderCandidatesQuery,
  rehydrateCorpusIndexProviderCandidatesStatement,
} from "@/api/lib/legal-search/corpus-index-provider";
import { RELEVANCE_ORDER } from "@/api/lib/legal-search/corpus-search-order";
import { corpusIndexId } from "@/api/lib/legal-search/index-naming";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import { installCorpusDispositionScan } from "@/api/tests/helpers/corpus-disposition-scan";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";
import { explainRoot } from "@/api/tests/query-plans/plan-walker";

/**
 * Search reads Postgres twice per request. The blend read answers for every
 * candidate the scan reaches — a few hundred per request — and carries only
 * what ranking and the language fold consume. The page read answers for the
 * ids the page emits and carries what a result card shows. These tests hold
 * the split: what each read returns, that the request's filters bind on both,
 * and that a candidate is read once however many rounds the scan spends.
 */

const GENERATION = "case_law_v5";
/** A second generation, holding a different set of decisions. */
const OTHER_GENERATION = "case_law_v6";
const INDEX_ID = corpusIndexId(GENERATION, "CZE");
const OTHER_INDEX_ID = corpusIndexId(OTHER_GENERATION, "CZE");
const APPLIED_FINGERPRINT = "a".repeat(64);
const DESIRED_FINGERPRINT = "b".repeat(64);
const sourceId = createSafeId<"caseLawSource">();
const closedSourceId = createSafeId<"caseLawSource">();
const czechId = createSafeId<"caseLawDecision">();
const slovakId = createSafeId<"caseLawDecision">();
const foreignId = createSafeId<"caseLawDecision">();
const closedId = createSafeId<"caseLawDecision">();
const projectedId = createSafeId<"caseLawDecision">();
const queuedId = createSafeId<"caseLawDecision">();
const czechIntentId = createSafeId<"corpusIndexProjectionIntent">();
const slovakIntentId = createSafeId<"corpusIndexProjectionIntent">();
const closedIntentId = createSafeId<"corpusIndexProjectionIntent">();
const projectedIntentId = createSafeId<"corpusIndexProjectionIntent">();
const queuedIntentId = createSafeId<"corpusIndexProjectionIntent">();

/** Same budget as the schema push: an embedded Postgres is not fast. */
const DB_TEST_TIMEOUT_MS = 120_000;
const SEARCH_BODY = { country: "CZE", query: "promlčení" } as const;

let client: PGlite;
let caseLawDb: CaseLawPublicReadDb;
let reads: number;

/** The request's record of blend rows, as the handler holds it. */
type HydratedRows = NonNullable<
  Parameters<typeof rehydrateCaseLawCandidates>[0]["hydrated"]
>;

const candidatesOf = (...ids: string[]) => ids.map((id) => ({ id, score: 1 }));

/** The registry as a request holds it, without a database to read it from. */
const courtWeights = courtWeightMapFromSeed();

type HeldProjectionOptions = {
  entityId: string;
  generation: string;
  indexId: string;
  intentId: SafeId<"corpusIndexProjectionIntent">;
};

/**
 * One decision a generation holds: applied equals desired on every field the
 * read compares, in the index the generation routes the decision's country to.
 */
const heldProjection = ({
  entityId,
  generation,
  indexId,
  intentId,
}: HeldProjectionOptions) => {
  const appliedAt = new Date();
  return {
    intent: {
      id: intentId,
      family: "case_law" as const,
      generation,
      entityId,
      epoch: 1n,
      fingerprint: APPLIED_FINGERPRINT,
      indexId,
      status: "applied" as const,
      appendStartedAt: appliedAt,
      appendCommittedAt: appliedAt,
      expectedDocumentCount: 1,
      appliedAt,
    },
    state: {
      family: "case_law" as const,
      generation,
      entityId,
      desiredAction: "upsert" as const,
      desiredEpoch: 1n,
      desiredFingerprint: APPLIED_FINGERPRINT,
      desiredIndexId: indexId,
      appliedAction: "upsert" as const,
      appliedEpoch: 1n,
      appliedRevision: intentId,
      appliedFingerprint: APPLIED_FINGERPRINT,
      appliedIndexId: indexId,
      appliedAt,
    },
  };
};

beforeAll(
  async () => {
    client = await createTestPglite();
    const db = drizzle({ client });
    const readDb = async <T>(
      fn: (tx: CaseLawPublicReadTransaction) => Promise<T>,
    ) => {
      reads += 1;
      return await withPublicLawReaderRole(db, async (roleTx) => {
        // SAFETY: the role transaction supplies the select surface the reads use.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test handle stands in for a transaction
        const tx = roleTx as unknown as CaseLawPublicReadTransaction;
        return await fn(tx);
      });
    };
    // SAFETY: brand-only wrapper; the reads never inspect the marker.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the branded handle carries no behaviour
    caseLawDb = readDb as unknown as CaseLawPublicReadDb;

    await db.insert(caseLawSources).values([
      caseLawSourceRow({ adapterKey: "open", id: sourceId, name: "open" }),
      caseLawSourceRow({
        adapterKey: "closed",
        descriptor: {
          allowsDerivedAi: false,
          allowsRedistribution: false,
          attribution: null,
          license: "restricted",
        },
        id: closedSourceId,
        name: "closed",
      }),
    ]);
    await db.insert(caseLawDecisions).values([
      {
        id: czechId,
        sourceId,
        caseNumber: "22 Cdo 1/2026",
        court: "Nejvyšší soud",
        country: "CZE",
        language: "cs",
        languageGroupKey: "hydration-group",
        contentHash: "hash-cze",
        decisionType: "nález",
        citationAuthority: 2,
        citationCount: 7,
        metadata: { category: "A", legalSentence: "Právní věta." },
      },
      {
        id: slovakId,
        sourceId,
        caseNumber: "22 Cdo 1/2026",
        court: "Nejvyšší soud",
        country: "CZE",
        language: "sk",
        languageGroupKey: "hydration-group",
        contentHash: "hash-svk",
        metadata: { category: "B" },
        decisionType: "Nález",
        citationAuthority: 1,
        citationCount: 3,
      },
      {
        id: foreignId,
        sourceId,
        caseNumber: "1 Cdo 2/2026",
        court: "Najvyšší súd",
        country: "SVK",
        language: "sk",
        contentHash: "hash-foreign",
        decisionType: "Nález",
        indexedHash: "hash-foreign",
      },
      {
        id: closedId,
        sourceId: closedSourceId,
        caseNumber: "1 Afs 2/2026",
        court: "Nejvyšší správní soud",
        country: "CZE",
        language: "cs",
        contentHash: "hash-closed",
      },
      {
        id: projectedId,
        sourceId,
        caseNumber: "30 Cdo 3/2026",
        court: "Nejvyšší soud",
        country: "CZE",
        language: "cs",
        languageGroupKey: "projected-group",
        contentHash: "hash-projected",
      },
      {
        id: queuedId,
        sourceId,
        caseNumber: "30 Cdo 4/2026",
        court: "Nejvyšší soud",
        country: "CZE",
        language: "cs",
        languageGroupKey: "queued-group",
        contentHash: "hash-queued",
      },
    ]);

    await db.insert(corpusIndexGenerations).values(
      ([GENERATION, OTHER_GENERATION] as const).map((generation) => ({
        family: "case_law" as const,
        generation,
        cluster: "q09" as const,
        manifestDigest: corpusIndexManifestDigest(
          CORPUS_INDEX_MANIFESTS[generation],
        ),
        status: "building" as const,
      })),
    );

    // What a generation holds is stated by its projection state alone.
    const held = [
      {
        entityId: czechId,
        generation: GENERATION,
        indexId: INDEX_ID,
        intentId: czechIntentId,
      },
      {
        entityId: slovakId,
        generation: GENERATION,
        indexId: INDEX_ID,
        intentId: slovakIntentId,
      },
      {
        entityId: foreignId,
        generation: GENERATION,
        indexId: INDEX_ID,
        intentId: createSafeId<"corpusIndexProjectionIntent">(),
      },
      {
        entityId: closedId,
        generation: GENERATION,
        indexId: INDEX_ID,
        intentId: closedIntentId,
      },
      {
        entityId: projectedId,
        generation: OTHER_GENERATION,
        indexId: OTHER_INDEX_ID,
        intentId: projectedIntentId,
      },
    ].map(heldProjection);
    const queuedAt = new Date();
    await db.insert(corpusIndexProjectionIntents).values([
      ...held.map(({ intent }) => intent),
      {
        id: queuedIntentId,
        family: "case_law",
        generation: OTHER_GENERATION,
        entityId: queuedId,
        epoch: 1n,
        fingerprint: APPLIED_FINGERPRINT,
        indexId: OTHER_INDEX_ID,
        status: "applied",
        appendStartedAt: queuedAt,
        appendCommittedAt: queuedAt,
        expectedDocumentCount: 1,
        appliedAt: queuedAt,
      },
    ]);
    await db.insert(corpusIndexProjectionStates).values([
      ...held.map(({ state }) => state),
      // The applied revision is behind a queued content change, so what the
      // engine holds for this decision is not what the generation wants.
      {
        family: "case_law",
        generation: OTHER_GENERATION,
        entityId: queuedId,
        desiredAction: "upsert",
        desiredEpoch: 2n,
        desiredFingerprint: DESIRED_FINGERPRINT,
        desiredIndexId: OTHER_INDEX_ID,
        appliedAction: "upsert",
        appliedEpoch: 1n,
        appliedRevision: queuedIntentId,
        appliedFingerprint: APPLIED_FINGERPRINT,
        appliedIndexId: OTHER_INDEX_ID,
        appliedAt: queuedAt,
      },
    ]);
  },
  { timeout: DB_TEST_TIMEOUT_MS },
);

beforeEach(() => {
  reads = 0;
});

afterAll(async () => {
  await client.close();
});

test("the blend read carries what ranking and the fold need, and nothing a card shows", async () => {
  const hydrated: HydratedRows = new Map();
  const ranking = await rehydrateCaseLawCandidates({
    body: SEARCH_BODY,
    candidates: candidatesOf(czechId, slovakId),
    caseLawDb,
    courtWeights,
    generation: GENERATION,
    hydrated,
  });

  // Two language versions of one judgment fold into their best-blended member.
  expect(ranking.ranked.map((hit) => hit.id)).toEqual([czechId]);
  expect(ranking.ranked.at(0)?.citationAuthority).toBe(2);
  expect([...hydrated.keys()].toSorted()).toEqual(
    [czechId, slovakId].toSorted(),
  );
  for (const row of hydrated.values()) {
    expect(Object.keys(row ?? {}).toSorted()).toEqual([
      "appliedRevision",
      "canRecur",
      "citationAuthority",
      "country",
      "court",
      "courtId",
      "id",
      "languageGroupKey",
    ]);
  }
});

test("a candidate is read once however many rounds ask for it", async () => {
  const hydrated: HydratedRows = new Map();
  await rehydrateCaseLawCandidates({
    body: SEARCH_BODY,
    candidates: candidatesOf(czechId),
    caseLawDb,
    courtWeights,
    generation: GENERATION,
    hydrated,
  });
  expect(reads).toBe(1);

  // The second round accumulates the first round's candidates plus one more:
  // only the new id may reach the database.
  await rehydrateCaseLawCandidates({
    body: SEARCH_BODY,
    candidates: candidatesOf(czechId, slovakId),
    caseLawDb,
    courtWeights,
    generation: GENERATION,
    hydrated,
  });
  expect(reads).toBe(2);

  // A round that adds nothing new asks the database for nothing at all.
  await rehydrateCaseLawCandidates({
    body: SEARCH_BODY,
    candidates: candidatesOf(czechId, slovakId),
    caseLawDb,
    courtWeights,
    generation: GENERATION,
    hydrated,
  });
  expect(reads).toBe(2);
});

test("the page read carries what a result card shows, for the page ids only", async () => {
  const rows = await readCaseLawPageDecisionRows({
    body: SEARCH_BODY,
    caseLawDb,
    generation: GENERATION,
    ids: [czechId],
  });

  expect([...rows.keys()]).toEqual([czechId]);
  const row = rows.get(czechId);
  expect(row?.caseNumber).toBe("22 Cdo 1/2026");
  expect(row?.court).toBe("Nejvyšší soud");
  expect(row?.citationCount).toBe(7);
  // The publisher summary is SQL over `metadata`, and it is the reason the
  // wide row is worth reading only for the ids the page emits.
  expect(row?.headnote).toBe("Právní věta.");
});

test("an empty page reads nothing", async () => {
  const rows = await readCaseLawPageDecisionRows({
    body: SEARCH_BODY,
    caseLawDb,
    generation: GENERATION,
    ids: [],
  });

  expect(rows.size).toBe(0);
  expect(reads).toBe(0);
});

test.each(["unchanged", "refreshed"] as const)(
  "the final search page exposes passages only while their applied revision is %s",
  async (revisionState) => {
    const db = drizzle({ client });
    const manifest = CORPUS_INDEX_MANIFESTS.case_law_v7;
    const indexId = corpusIndexId(manifest.generation, "CZE");
    const originalRevision = createSafeId<"corpusIndexProjectionIntent">();
    const refreshedRevision = createSafeId<"corpusIndexProjectionIntent">();
    expect(originalRevision).not.toBe(refreshedRevision);
    const projection = heldProjection({
      entityId: czechId,
      generation: manifest.generation,
      indexId,
      intentId: originalRevision,
    });
    await db
      .insert(corpusIndexGenerations)
      .values({
        family: "case_law",
        generation: manifest.generation,
        cluster: manifest.cluster,
        manifestDigest: corpusIndexManifestDigest(manifest),
        status: "building",
      })
      .onConflictDoNothing();
    await db
      .insert(corpusIndexProjectionIntents)
      .values([
        projection.intent,
        { ...projection.intent, id: refreshedRevision, epoch: 2n },
      ]);
    await db.insert(corpusIndexProjectionStates).values(projection.state);
    const resolution = corpusIndexReadTarget({
      manifest,
      jurisdiction: "CZE",
      attestedGroups: new Set(),
      enrolledGroups: new Set(),
    });
    if (resolution.type !== "ready") {
      panic("Expected the Czech corpus group to be ready");
    }
    const anchorId = "revision-a-passage";
    const snippet = "<b>Promlčení</b> podle původní úpravy.";
    const headline = "<mark>Promlčení</mark> podle původní úpravy.";
    let highlighted = 0;
    const searchSpy = spyOn(
      getCorpusIndexClient(manifest.cluster),
      "search",
    ).mockImplementation(async (options) => {
      if (options.snippetFields?.includes("text")) {
        highlighted += 1;
        expect(options.query).toContain(originalRevision);
        const candidateRows = await readCaseLawPageDecisionRows({
          body: SEARCH_BODY,
          caseLawDb,
          generation: manifest.generation,
          ids: [czechId],
        });
        expect(candidateRows.get(czechId)?.appliedRevision).toBe(
          originalRevision,
        );
        if (revisionState === "refreshed") {
          await db
            .update(corpusIndexProjectionStates)
            .set({
              desiredEpoch: 2n,
              appliedEpoch: 2n,
              appliedRevision: refreshedRevision,
            })
            .where(
              and(
                eq(corpusIndexProjectionStates.entityId, czechId),
                eq(corpusIndexProjectionStates.generation, manifest.generation),
              ),
            );
        }
      }
      return Result.ok({
        numHits: 1,
        hits: [{ document_id: czechId, anchor_id: anchorId }],
        snippets: options.snippetFields?.includes("text")
          ? [{ text: [snippet] }]
          : [],
      });
    });
    resetPublicCaseLawConfigForTesting(caseLawDb);
    try {
      const result = await searchCorpusIndexDecisions({
        body: { ...SEARCH_BODY, category: "A", limit: 1, sort: "newest" },
        caseLawDb,
        observer: "unobserved",
        dependencies: {
          configuredVariant: "off",
          readServingTarget: async () =>
            Result.ok({
              ...resolution.target,
              manifest,
              serving: {
                family: "case_law",
                generation: manifest.generation,
                cluster: manifest.cluster,
              },
            }),
        },
      });
      if (!("hits" in result)) {
        panic("Expected a successful indexed search page");
      }
      expect(highlighted).toBe(1);
      expect(result.hits).toHaveLength(1);
      const hit = result.hits.at(0) ?? panic("Expected the hydrated decision");
      expect(hit.headline).toBe(
        revisionState === "refreshed" ? null : headline,
      );
      expect(hit.anchorId).toBe(
        revisionState === "refreshed" ? null : anchorId,
      );
      const finalRows = await readCaseLawPageDecisionRows({
        body: SEARCH_BODY,
        caseLawDb,
        generation: manifest.generation,
        ids: [czechId],
      });
      expect(finalRows.get(czechId)?.appliedRevision).toBe(
        revisionState === "refreshed" ? refreshedRevision : originalRevision,
      );
    } finally {
      searchSpy.mockRestore();
      resetPublicCaseLawConfigForTesting();
      await db
        .delete(corpusIndexProjectionStates)
        .where(
          and(
            eq(corpusIndexProjectionStates.entityId, czechId),
            eq(corpusIndexProjectionStates.generation, manifest.generation),
          ),
        );
      await db
        .delete(corpusIndexProjectionIntents)
        .where(
          inArray(corpusIndexProjectionIntents.id, [
            originalRevision,
            refreshedRevision,
          ]),
        );
    }
  },
);

test("a generation admits exactly what its projection state holds", async () => {
  const scoped = {
    body: SEARCH_BODY,
    caseLawDb,
    courtWeights,
    generation: OTHER_GENERATION,
  };

  const ranking = await rehydrateCaseLawCandidates({
    ...scoped,
    candidates: candidatesOf(projectedId, queuedId, czechId),
  });
  // Applied equals desired for the first decision. The second still owes the
  // index a mutation, and the third has no state row in this generation.
  expect(ranking.ranked.map((hit) => hit.id)).toEqual([projectedId]);

  const rows = await readCaseLawPageDecisionRows({
    body: scoped.body,
    caseLawDb,
    generation: OTHER_GENERATION,
    ids: [projectedId, queuedId, czechId],
  });
  expect([...rows.keys()]).toEqual([projectedId]);
});

test("a generation admits nothing another generation holds", async () => {
  const ranking = await rehydrateCaseLawCandidates({
    body: SEARCH_BODY,
    candidates: candidatesOf(projectedId, czechId),
    caseLawDb,
    courtWeights,
    generation: GENERATION,
  });

  expect(ranking.ranked.map((hit) => hit.id)).toEqual([czechId]);
});

test("both reads reapply the request filters and the redistribution boundary", async () => {
  const scoped = {
    body: { country: "CZE", query: "promlčení" },
    caseLawDb,
    courtWeights,
    generation: GENERATION,
  };

  const ranking = await rehydrateCaseLawCandidates({
    ...scoped,
    candidates: candidatesOf(czechId, foreignId, closedId),
  });
  // The foreign decision no longer matches the country filter, and the closed
  // source is not redistributable, so neither can stand for the judgment.
  expect(ranking.ranked.map((hit) => hit.id)).toEqual([czechId]);

  const rows = await readCaseLawPageDecisionRows({
    ...scoped,
    ids: [czechId, foreignId, closedId],
  });
  expect([...rows.keys()]).toEqual([czechId]);
});

test.each([
  { category: "A", hasLegalSentence: true, expectedIds: [czechId] },
  { category: "B", hasLegalSentence: false, expectedIds: [slovakId] },
  { category: "A", hasLegalSentence: false, expectedIds: [] },
  { category: "B", hasLegalSentence: true, expectedIds: [] },
])(
  "both indexed reads apply category $category and sentence presence $hasLegalSentence",
  async ({ category, hasLegalSentence, expectedIds }) => {
    const body = { ...SEARCH_BODY, category, hasLegalSentence };
    const ranking = await rehydrateCaseLawCandidates({
      body,
      candidates: candidatesOf(czechId, slovakId),
      caseLawDb,
      courtWeights,
      generation: GENERATION,
    });
    expect(ranking.ranked.map(({ id }) => id)).toEqual([...expectedIds]);
    const rows = await readCaseLawPageDecisionRows({
      body,
      caseLawDb,
      generation: GENERATION,
      ids: [czechId, slovakId],
    });
    expect([...rows.keys()]).toEqual([...expectedIds]);
  },
);

test.each([true, false])(
  "metadata filters keep the decision-id access path (%s)",
  async (hasLegalSentence) => {
    await caseLawDb(async (tx) => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      const options = {
        body: { ...SEARCH_BODY, category: "A", hasLegalSentence },
        generation: GENERATION,
        ids: [czechId, slovakId],
      };
      for (const query of [
        candidateDecisionRowsStatement(tx, options),
        pageDecisionRowsStatement(tx, options),
      ]) {
        const plan = JSON.stringify(
          await tx.execute(sql`EXPLAIN (COSTS OFF) ${query.getSQL()}`),
        );
        expect(plan).toMatch(
          /(?:Index(?: Only)? Scan using|Bitmap Index Scan on) case_law_decisions_(?:pkey|search_candidate_idx)/u,
        );
        expect(plan).toContain("Index Cond:");
        expect(plan).toContain("id = ANY");
        expect(plan).not.toContain("Seq Scan on case_law_decisions");
      }
    });
  },
);

test("corpus hydration and page reads apply the same case-insensitive type filter", async () => {
  for (const country of ["CZE", "SVK"]) {
    const expected = country === "CZE" ? [czechId, slovakId] : [foreignId];
    for (const decisionType of ["nález", "Nález", "NÁLEZ"]) {
      const hydrated: HydratedRows = new Map();
      const scoped = {
        body: { ...SEARCH_BODY, country, decisionType },
        caseLawDb,
        courtWeights,
        generation: GENERATION,
      };
      await rehydrateCaseLawCandidates({
        ...scoped,
        candidates: candidatesOf(czechId, slovakId, foreignId, closedId),
        hydrated,
      });
      // Rejected candidates stay cached as null so later rounds do not reread them.
      const matchedIds = [...hydrated]
        .filter(([, row]) => row !== null)
        .map(([id]) => id);
      expect(matchedIds.toSorted()).toEqual(expected.toSorted());
      for (const id of [czechId, slovakId, foreignId, closedId]) {
        if (!expected.includes(id)) {
          expect(hydrated.get(id)).toBeNull();
        }
      }
      const rows = await readCaseLawPageDecisionRows({
        ...scoped,
        ids: [czechId, slovakId, foreignId, closedId],
      });
      expect([...rows.keys()].toSorted()).toEqual(expected.toSorted());
    }
  }
});

test("rehydration accounts for exclusions and absent canonical rows in one read", async () => {
  const hitDispositions = createCorpusHitDispositionCounter();
  const missingId = createSafeId<"caseLawDecision">();
  const hydrated: HydratedRows = new Map();
  const options = {
    body: SEARCH_BODY,
    caseLawDb,
    courtWeights,
    generation: GENERATION,
    hydrated,
    hitDispositions,
    candidates: candidatesOf(czechId, foreignId, closedId, queuedId, missingId),
  };
  const result = await rehydrateCaseLawCandidates(options);
  expect(result.ranked.map((hit) => hit.id)).toEqual([czechId]);
  expect(hitDispositions.snapshot()).toEqual({
    malformed: 0,
    excluded: 3,
    drift: 1,
  });
  await rehydrateCaseLawCandidates(options);
  expect(hitDispositions.snapshot()).toEqual({
    malformed: 0,
    excluded: 3,
    drift: 1,
  });
  expect(reads).toBe(1);
});

test("the shared provider accounts for canonical eligibility with its existing batch", async () => {
  const hitDispositions = createCorpusHitDispositionCounter();
  const missingId = createSafeId<"caseLawDecision">();
  const result = await rankCorpusIndexProviderCandidates({
    generation: GENERATION,
    caseLawDb,
    hitDispositions,
    candidates: candidatesOf(czechId, closedId, queuedId, missingId),
    excludedGroups: undefined,
  });
  expect(result.ranked.map((row) => row.id)).toEqual([czechId]);
  expect([...result.context.displayById.keys()]).toEqual([czechId]);
  expect(hitDispositions.snapshot()).toEqual({
    malformed: 0,
    excluded: 2,
    drift: 1,
  });
  expect(reads).toBe(1);
});

test("the final page read accounts for canonical exclusions before presentation", async () => {
  const hitDispositions = createCorpusHitDispositionCounter();
  const missingId = createSafeId<"caseLawDecision">();
  const rows = await readCaseLawPageDecisionRows({
    body: SEARCH_BODY,
    generation: GENERATION,
    caseLawDb,
    hitDispositions,
    ids: [czechId, foreignId, closedId, missingId],
  });
  expect([...rows.keys()]).toEqual([czechId]);
  expect(hitDispositions.snapshot()).toEqual({
    malformed: 0,
    excluded: 2,
    drift: 1,
  });
  expect(reads).toBe(1);
});

test("canonical reads return content only for eligible rows and separate id-only dispositions", async () => {
  const missingId = createSafeId<"caseLawDecision">();
  const ids = [czechId, closedId, queuedId, missingId];
  await caseLawDb(async (tx) => {
    const options = { generation: GENERATION, ids, body: SEARCH_BODY };
    const partitions = [
      await candidateDecisionRowsQuery(tx, options),
      await pageDecisionRowsQuery(tx, options),
      await rehydrateCorpusIndexProviderCandidatesQuery(tx, options),
    ];
    for (const read of partitions) {
      expect(read.rows.map((row) => row.id)).toEqual([czechId]);
      expect(read.dispositions).toEqual(
        expect.arrayContaining([
          { id: closedId, type: "excluded" },
          { id: queuedId, type: "excluded" },
          { id: missingId, type: "drift" },
        ]),
      );
      expect(read.dispositions).toHaveLength(3);
      expect(JSON.stringify(read)).not.toContain("1 Afs 2/2026");
    }
  });
});

test("the database returns no content columns for excluded canonical ids", async () => {
  await caseLawDb(async (tx) => {
    const options = {
      body: SEARCH_BODY,
      generation: GENERATION,
      ids: [closedId, queuedId],
    };
    const statements = [
      candidateDecisionRowsStatement(tx, options),
      pageDecisionRowsStatement(tx, options),
      rehydrateCorpusIndexProviderCandidatesStatement(tx, options),
    ];
    for (const statement of statements) {
      const records = await statement;
      expect(records).toEqual(
        expect.arrayContaining([
          { id: closedId, row: null },
          { id: queuedId, row: null },
        ]),
      );
      expect(records).toHaveLength(2);
      const result = await tx.execute(
        sql`EXPLAIN (ANALYZE, COSTS OFF, FORMAT JSON) ${statement.getSQL()}`,
      );
      const nodes = [explainRoot(result)];
      let identifiers = 0;
      for (let index = 0; index < nodes.length; index += 1) {
        const node = nodes.at(index) ?? panic("Missing EXPLAIN node");
        if (node["Relation Name"] === "case_law_decision_identifiers") {
          identifiers += 1;
          expect(node["Actual Loops"]).toBe(0);
        }
        const children = node["Plans"];
        if (children !== undefined) {
          if (!isUnknownArray(children) || !children.every(isRecord)) {
            panic("Malformed EXPLAIN children");
          }
          nodes.push(...children);
        }
      }
      if (statement === statements.at(0)) {
        expect(identifiers).toBe(0);
      } else {
        expect(identifiers).toBeGreaterThan(0);
      }
    }
  });
});

test("provider scan counts retained omissions once as eligible candidates grow", async () => {
  const hitDispositions = createCorpusHitDispositionCounter();
  const missingId = createSafeId<"caseLawDecision">();
  const eligibleIds = [czechId, slovakId];
  const restoreFetch = installCorpusDispositionScan([
    closedId,
    missingId,
    ...eligibleIds,
  ]);
  const candidateCounts: number[] = [];
  const eligibleCounts: number[] = [];
  try {
    const page = await readCorpusIndexSearchPage({
      observer: "unobserved",
      cluster: "q09",
      indexId: INDEX_ID,
      query: "text:fixture",
      limit: 40,
      order: RELEVANCE_ORDER,
      parsedCursor: null,
      hitDispositions,
      rankingMode: "off",
      snippetFields: ["text"],
      projectionRevisionField: "projection_revision",
      extractId: (hit) =>
        typeof hit["document_id"] === "string" ? hit["document_id"] : null,
      extractSnippet: () => null,
      unseenScoreUpperBound: () => 0,
      rankCandidates: async (candidates) => {
        candidateCounts.push(candidates.length);
        const result = await rankCorpusIndexProviderCandidates({
          generation: GENERATION,
          caseLawDb,
          hitDispositions,
          candidates,
          excludedGroups: undefined,
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
