import type { PGlite } from "@electric-sql/pglite";
import { panic, Result } from "better-result";
import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import {
  DEFAULT_SEARCH_EXCERPT,
  DEFAULT_SEARCH_SORT,
  SEARCH_TOTAL_NOT_COUNTED,
} from "@stll/api-contract/search";

import {
  caseLawDecisions,
  caseLawProvisionCitations,
  caseLawSearchDocuments,
  caseLawSources,
  corpusIndexGenerations,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import { courtWeightMapFromSeed } from "@/api/handlers/case-law/court-weight-seed";
import {
  candidateDecisionRowsQuery,
  candidateDecisionRowsStatement,
  caseLawSearchPlan,
  decisionHitsPage,
  listCaseLawProvisionDecisions,
  pageDecisionRowsQuery,
  pageDecisionRowsStatement,
  readCaseLawPageDecisionRows,
  rehydrateCaseLawCandidates,
  searchCorpusIndexDecisions,
  searchPostgresDecisions,
} from "@/api/handlers/case-law/decisions/search";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { provisionScopeLinksQuery } from "@/api/lib/case-law/provision-filter";
import { resetPublicCaseLawConfigForTesting } from "@/api/lib/case-law/public-case-law-config";
import { createCorpusHitDispositionCounter } from "@/api/lib/legal-search/corpus-hit-telemetry";
import { getCorpusIndexClient } from "@/api/lib/legal-search/corpus-index-client";
import { corpusIndexReadTarget } from "@/api/lib/legal-search/corpus-index-group-contract";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import {
  corpusIndexLexicalScore,
  NATIVE_SCAN_TRANSPORT,
  readCorpusIndexSearchPage,
} from "@/api/lib/legal-search/corpus-index-pagination";
import {
  rankCorpusIndexProviderCandidates,
  rehydrateCorpusIndexProviderCandidatesQuery,
  rehydrateCorpusIndexProviderCandidatesStatement,
} from "@/api/lib/legal-search/corpus-index-provider";
import { CORPUS_BM25_RATIO_POWER } from "@/api/lib/legal-search/corpus-ranking-policy";
import { RELEVANCE_ORDER } from "@/api/lib/legal-search/corpus-search-order";
import { corpusIndexId } from "@/api/lib/legal-search/index-naming";
import {
  decodePaginationCursor,
  encodePaginationCursor,
} from "@/api/lib/pagination";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import {
  installCorpusDispositionScan,
  installCorpusRevisionScan,
} from "@/api/tests/helpers/corpus-disposition-scan";
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
const withheldSourceId = createSafeId<"caseLawSource">();
const withheldIntentId = createSafeId<"corpusIndexProjectionIntent">();
const withheldId = createSafeId<"caseLawDecision">();
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
    await client.exec(
      "CREATE TEXT SEARCH CONFIGURATION public.stella_unaccent (COPY = pg_catalog.simple)",
    );
    const readDb = async <T>(
      fn: (tx: CaseLawPublicReadTransaction) => Promise<T>,
    ) => {
      reads += 1;
      return await withPublicLawReaderRole(db, async (roleTx) => {
        const adaptedTx = {
          select: roleTx.select.bind(roleTx),
          query: roleTx.query,
          execute: async (statement: Parameters<typeof roleTx.execute>[0]) => {
            const result = await roleTx.execute(statement);
            // Public SQL readers accept postgres-js arrays and PGlite's rows envelope.
            return Object.assign(result.rows, { rows: result.rows });
          },
        };
        // SAFETY: the role transaction supplies the select surface the reads use.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test handle stands in for a transaction
        const tx = adaptedTx as unknown as CaseLawPublicReadTransaction;
        return await fn(tx);
      });
    };
    // SAFETY: brand-only wrapper; the reads never inspect the marker.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the branded handle carries no behaviour
    caseLawDb = readDb as unknown as CaseLawPublicReadDb;

    await db.insert(caseLawSources).values([
      caseLawSourceRow({ adapterKey: "open", id: sourceId, name: "open" }),
      caseLawSourceRow({
        adapterKey: "withheld",
        id: withheldSourceId,
        descriptor: {
          allowsDerivedAi: false,
          allowsRedistribution: true,
          attribution: null,
          license: "restricted",
        },
      }),
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
        id: withheldId,
        sourceId: withheldSourceId,
        caseNumber: "12 Cdo 2/2026",
        court: "Nejvyšší soud",
        country: "CZE",
        language: "cs",
        fulltext: "sampleword",
        metadata: { headnote: "sampleword summary" },
      },
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

    const link = (
      decisionId: SafeId<"caseLawDecision">,
      work: { number: number; year: number },
      section: number,
      subsection: string | null,
      spanStart: number,
    ): typeof caseLawProvisionCitations.$inferInsert => {
      const anchor = `par_${String(section)}${subsection === null ? "" : `-odst_${subsection}`}`;
      return {
        anchor,
        confidence: 0.9,
        decisionDate: "2024-01-01",
        decisionId,
        jurisdiction: "CZE",
        section,
        subsection,
        sentenceText: `sentence ${anchor}`,
        spanEnd: spanStart + 10,
        spanStart,
        unit: "section",
        workCollection: "Sb.",
        workIdentifier: `${String(work.number)}/${String(work.year)} Sb.`,
        workNumber: work.number,
        workYear: work.year,
      };
    };
    const labourCode = { number: 262, year: 2006 };
    const civilCode = { number: 89, year: 2012 };
    await db
      .insert(caseLawProvisionCitations)
      .values([
        link(czechId, labourCode, 316, "2", 10),
        link(slovakId, labourCode, 31, null, 10),
        link(slovakId, civilCode, 316, "1", 30),
      ]);

    await db.insert(caseLawSearchDocuments).values(
      [czechId, withheldId].map((decisionId) => ({
        decisionId,
        language: "cs",
        regconfig: "simple",
        searchableText: "sampleword",
        tsv: sql`to_tsvector('simple', 'sampleword')`,
      })),
    );

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
        entityId: withheldId,
        generation: GENERATION,
        indexId: INDEX_ID,
        intentId: withheldIntentId,
      },
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

test.each([
  { selection: "count only", facets: [] },
  { selection: "court only", facets: ["court"] },
  { selection: "matrix only", facets: ["courtYear"] },
] as const)(
  "indexed search requests $selection while preserving its decision total",
  async ({ selection, facets }) => {
    const db = drizzle({ client });
    const manifest = CORPUS_INDEX_MANIFESTS.case_law_v7;
    const indexId = corpusIndexId(manifest.generation, "CZE");
    const projection = heldProjection({
      entityId: czechId,
      generation: manifest.generation,
      indexId,
      intentId: createSafeId<"corpusIndexProjectionIntent">(),
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
    await db.insert(corpusIndexProjectionIntents).values(projection.intent);
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
    const engine = getCorpusIndexClient(manifest.cluster);
    const requestedAggregations: string[] = [];
    const scoredSpy = spyOn(engine, "scoredSearch").mockImplementation(
      async () =>
        Result.ok({
          numHits: 1,
          hits: [
            {
              fields: {
                document_id: czechId,
                projection_revision: projection.intent.id,
                anchor_id: "facet-selection-passage",
              },
              score: 1,
            },
          ],
        }),
    );
    const searchSpy = spyOn(engine, "search").mockImplementation(async () =>
      Result.ok({
        numHits: 1,
        hits: [
          {
            document_id: czechId,
            projection_revision: projection.intent.id,
            anchor_id: "facet-selection-passage",
          },
        ],
        snippets: [{ text: ["<b>Facet</b> selection"] }],
      }),
    );
    const aggregateSpy = spyOn(engine, "aggregate").mockImplementation(
      async ({ aggs }) => {
        requestedAggregations.push(...Object.keys(aggs));
        const answered: Record<string, unknown> = {};
        for (const name of Object.keys(aggs)) {
          switch (name) {
            case "total":
              answered[name] = { value: 412 };
              break;
            case "courtYear":
              answered[name] = {
                sum_other_doc_count: 0,
                doc_count_error_upper_bound: 0,
                buckets: [
                  {
                    key: "Nejvyšší soud",
                    years: {
                      buckets: [
                        {
                          key: "2024",
                          doc_count: 40,
                          decisions: { value: 3 },
                        },
                      ],
                    },
                  },
                ],
              };
              break;
            default:
              answered[name] = {
                buckets: [
                  {
                    key: "Nejvyšší soud",
                    doc_count: 40,
                    decisions: { value: 3 },
                  },
                ],
              };
          }
        }
        return Result.ok(answered);
      },
    );
    resetPublicCaseLawConfigForTesting(caseLawDb);
    try {
      const result = await searchCorpusIndexDecisions({
        body: {
          country: "CZE",
          query: `facet selection ${selection}`,
          facets: [...facets],
          strict: true,
          limit: 1,
        },
        caseLawDb,
        observer: "unobserved",
        dependencies: {
          configuredVariant: "off",
          loadCourtWeights: async () => courtWeights,
          readSourceRegistry: async () =>
            Result.ok({
              excludedSourceIds: [],
              nameById: new Map(),
            }),
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
      expect(result.hits.map(({ decisionId }) => decisionId)).toEqual([
        czechId,
      ]);
      expect(result.total).toEqual({ type: "estimate", count: 412 });
      expect(requestedAggregations.toSorted()).toEqual(
        [...facets, "total"].toSorted(),
      );
      if (selection === "count only") {
        expect(result.facets).toBeNull();
        return;
      }
      expect(result.facets).not.toBeNull();
      expect(result.facets?.courtYear).toEqual(
        selection === "matrix only"
          ? {
              buckets: [
                {
                  court: "Nejvyšší soud",
                  courtName: "Nejvyšší soud",
                  courtAbbreviation: "NS",
                  tier: "supreme",
                  year: 2024,
                  count: 3,
                  citationSum: null,
                  treatment: null,
                },
              ],
              truncated: false,
            }
          : null,
      );
      expect(result.facets?.court.flatMap(({ courts }) => courts).length).toBe(
        selection === "court only" ? 1 : 0,
      );
    } finally {
      aggregateSpy.mockRestore();
      scoredSpy.mockRestore();
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
        .where(eq(corpusIndexProjectionIntents.id, projection.intent.id));
    }
  },
);

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
      "appliedGeneration",
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
        hits: [
          {
            document_id: czechId,
            anchor_id: anchorId,
            projection_revision: originalRevision,
          },
        ],
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

test("a short strict page is topped up with new partial matches only, after the strict hits", async () => {
  const db = drizzle({ client });
  const manifest = CORPUS_INDEX_MANIFESTS.case_law_v7;
  const indexId = corpusIndexId(manifest.generation, "CZE");
  // The strict hit, its Slovak language sibling, and one other decision.
  const held = [czechId, slovakId, projectedId].map((entityId) =>
    heldProjection({
      entityId,
      generation: manifest.generation,
      indexId,
      intentId: createSafeId<"corpusIndexProjectionIntent">(),
    }),
  );
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
    .values(held.map(({ intent }) => intent));
  await db
    .insert(corpusIndexProjectionStates)
    .values(held.map(({ state }) => state));
  const resolution = corpusIndexReadTarget({
    manifest,
    jurisdiction: "CZE",
    attestedGroups: new Set(),
    enrolledGroups: new Set(),
  });
  if (resolution.type !== "ready") {
    panic("Expected the Czech corpus group to be ready");
  }
  // Relevance scans run through the scored endpoint: each request scans
  // strictly first, and a second scan in the same request is the relaxed one,
  // which returns the strict hit again, its sibling and one new partial
  // match. Highlights run through the search endpoint, facets through the
  // aggregate one.
  let scans = 0;
  const engine = getCorpusIndexClient(manifest.cluster);
  const scoredSpy = spyOn(engine, "scoredSearch").mockImplementation(
    async () => {
      scans += 1;
      const ids = scans === 1 ? [czechId] : [czechId, slovakId, projectedId];
      return await Promise.resolve(
        Result.ok({
          numHits: ids.length,
          hits: ids.map((id, index) => ({
            fields: { document_id: id, anchor_id: `${id}-p` },
            score: 10 - index,
          })),
        }),
      );
    },
  );
  const searchSpy = spyOn(engine, "search").mockImplementation(
    async (options) => {
      const named = [czechId, slovakId, projectedId].filter((id) =>
        options.query.includes(id),
      );
      const ids = named.length === 0 ? [czechId] : named;
      return await Promise.resolve(
        Result.ok({
          numHits: ids.length,
          hits: ids.map((id) => ({ document_id: id, anchor_id: `${id}-p` })),
          snippets: ids.map(() => ({ text: ["<b>promlčení</b> nároku"] })),
        }),
      );
    },
  );
  const aggregateSpy = spyOn(engine, "aggregate").mockImplementation(
    async ({ aggs, query }) => {
      if ("term_coverage" in aggs) {
        const ids = query.includes("promlčení")
          ? [czechId, slovakId, projectedId].filter((id) => query.includes(id))
          : [];
        return Result.ok({
          term_coverage: {
            buckets: ids.toSorted().map((key) => ({ key, doc_count: 1 })),
            sum_other_doc_count: 0,
            doc_count_error_upper_bound: 0,
          },
        });
      }
      const answered: Record<string, unknown> = {};
      for (const name of Object.keys(aggs)) {
        answered[name] =
          name === "total"
            ? { value: 1 }
            : {
                buckets: [
                  {
                    key: name === "year" ? "2024" : `${name}-value`,
                    doc_count: 1,
                    decisions: { value: 1 },
                  },
                ],
              };
      }
      return await Promise.resolve(Result.ok(answered));
    },
  );
  resetPublicCaseLawConfigForTesting(caseLawDb);
  const search = async (strict: boolean) => {
    scans = 0;
    const result = await searchCorpusIndexDecisions({
      body: { country: "CZE", query: "promlčení nároku", limit: 5, strict },
      caseLawDb,
      observer: "unobserved",
      dependencies: {
        configuredVariant: "off",
        loadCourtWeights: async () => await Promise.resolve(courtWeights),
        readSourceRegistry: async () =>
          await Promise.resolve(
            Result.ok({ excludedSourceIds: [], nameById: new Map() }),
          ),
        readServingTarget: async () =>
          await Promise.resolve(
            Result.ok({
              ...resolution.target,
              manifest,
              serving: {
                family: "case_law",
                generation: manifest.generation,
                cluster: manifest.cluster,
              },
            }),
          ),
      },
    });
    if (!("hits" in result)) {
      panic("Expected a successful indexed search page");
    }
    return { result, scans };
  };
  try {
    const strictOnly = await search(true);
    expect(strictOnly.scans).toBe(1);
    const relaxed = await search(false);
    expect(relaxed.scans).toBe(2);
    expect(
      relaxed.result.hits.map(({ decisionId, match }) => ({
        decisionId,
        match,
      })),
    ).toEqual([
      { decisionId: String(czechId), match: "all_terms" },
      { decisionId: String(projectedId), match: "some_terms" },
    ]);
    // The total and facets stay the strict set's.
    expect(relaxed.result.total).toEqual(strictOnly.result.total);
    expect(relaxed.result.facets).toEqual(strictOnly.result.facets);
  } finally {
    scoredSpy.mockRestore();
    searchSpy.mockRestore();
    aggregateSpy.mockRestore();
    resetPublicCaseLawConfigForTesting();
    await db.delete(corpusIndexProjectionStates).where(
      and(
        inArray(
          corpusIndexProjectionStates.entityId,
          held.map(({ state }) => state.entityId),
        ),
        eq(corpusIndexProjectionStates.generation, manifest.generation),
      ),
    );
    await db.delete(corpusIndexProjectionIntents).where(
      inArray(
        corpusIndexProjectionIntents.id,
        held.map(({ intent }) => intent.id),
      ),
    );
  }
});

test.each([
  {
    strictHitCount: 0,
    configuredVariant: "off" as const,
    snippetMode: "full" as const,
  },
  {
    strictHitCount: 1,
    configuredVariant: "off" as const,
    snippetMode: "full" as const,
  },
  {
    strictHitCount: 0,
    configuredVariant: "core-stems-first" as const,
    snippetMode: "full" as const,
  },
  {
    strictHitCount: 1,
    configuredVariant: "core-stems-first" as const,
    snippetMode: "full" as const,
  },
  {
    strictHitCount: 0,
    configuredVariant: "off" as const,
    snippetMode: "missing" as const,
  },
  {
    strictHitCount: 0,
    configuredVariant: "off" as const,
    snippetMode: "truncated" as const,
  },
])(
  "a six-word question with $strictHitCount full matches reports its matching mode ($configuredVariant, $snippetMode snippets)",
  async ({ strictHitCount, configuredVariant, snippetMode }) => {
    const db = drizzle({ client });
    const manifest = CORPUS_INDEX_MANIFESTS.case_law_v7;
    const indexId = corpusIndexId(manifest.generation, "CZE");
    const query = "promlčení nároku náhrada škody smlouva odpovědnost";
    expect(query.split(" ")).toHaveLength(6);
    const held = [czechId, projectedId].map((entityId) =>
      heldProjection({
        entityId,
        generation: manifest.generation,
        indexId,
        intentId: createSafeId<"corpusIndexProjectionIntent">(),
      }),
    );
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
      .values(held.map(({ intent }) => intent));
    await db
      .insert(corpusIndexProjectionStates)
      .values(held.map(({ state }) => state));
    const resolution = corpusIndexReadTarget({
      manifest,
      jurisdiction: "CZE",
      attestedGroups: new Set(),
      enrolledGroups: new Set(),
    });
    if (resolution.type !== "ready") {
      panic("Expected the Czech corpus group to be ready");
    }
    let scans = 0;
    const engine = getCorpusIndexClient(manifest.cluster);
    const scoredSpy = spyOn(engine, "scoredSearch").mockImplementation(
      async () => {
        scans += 1;
        const strictIds = strictHitCount === 0 ? [] : [czechId];
        const ids = scans === 1 ? strictIds : [czechId, projectedId];
        return await Promise.resolve(
          Result.ok({
            numHits: ids.length,
            hits: ids.map((id, index) => ({
              fields: { document_id: id, anchor_id: `${id}-p` },
              score: 10 - index,
            })),
          }),
        );
      },
    );
    const snippets = new Map([
      [czechId, strictHitCount === 0 ? "promlčení" : query],
      [projectedId, "promlčení nároku náhrada škody"],
    ]);
    const searchSpy = spyOn(engine, "search").mockImplementation(
      async (options) => {
        const ids = [czechId, projectedId].filter((id) =>
          options.query.includes(id),
        );
        return await Promise.resolve(
          Result.ok({
            numHits: ids.length,
            hits: ids.map((id) => ({ document_id: id, anchor_id: `${id}-p` })),
            snippets:
              snippetMode === "missing"
                ? ids.map(() => ({}))
                : ids.map((id) => ({
                    text: [
                      snippetMode === "truncated" && id === projectedId
                        ? "promlčení"
                        : (snippets.get(id) ??
                          panic("Expected a fixture excerpt")),
                    ],
                  })),
          }),
        );
      },
    );
    const aggregateSpy = spyOn(engine, "aggregate").mockImplementation(
      async ({ aggs, query: aggregateQuery }) => {
        if ("term_coverage" in aggs) {
          // Whole-document coverage is independent of the optional excerpt:
          // the lower-scored decision matches four terms, the other only one.
          const projectedTerms = query.split(" ").slice(0, 4);
          let candidates: SafeId<"caseLawDecision">[] = [];
          if (aggregateQuery.includes("promlčení")) {
            candidates = [czechId, projectedId];
          } else if (
            projectedTerms.some((term) => aggregateQuery.includes(term))
          ) {
            candidates = [projectedId];
          }
          return Result.ok({
            term_coverage: {
              buckets: candidates
                .filter((id) => aggregateQuery.includes(id))
                .toSorted()
                .map((key) => ({ key, doc_count: 1 })),
              sum_other_doc_count: 0,
              doc_count_error_upper_bound: 0,
            },
          });
        }
        const answered: Record<string, unknown> = {};
        for (const name of Object.keys(aggs)) {
          answered[name] =
            name === "total" ? { value: strictHitCount } : { buckets: [] };
        }
        return await Promise.resolve(Result.ok(answered));
      },
    );
    resetPublicCaseLawConfigForTesting(caseLawDb);
    try {
      const result = await searchCorpusIndexDecisions({
        body: { country: "CZE", query, limit: strictHitCount === 0 ? 2 : 1 },
        caseLawDb,
        observer: "unobserved",
        dependencies: {
          configuredVariant,
          loadCourtWeights: async () => await Promise.resolve(courtWeights),
          readSourceRegistry: async () =>
            await Promise.resolve(
              Result.ok({ excludedSourceIds: [], nameById: new Map() }),
            ),
          readServingTarget: async () =>
            await Promise.resolve(
              Result.ok({
                ...resolution.target,
                manifest,
                serving: {
                  family: "case_law",
                  generation: manifest.generation,
                  cluster: manifest.cluster,
                },
              }),
            ),
        },
      });
      if (!("hits" in result)) {
        panic("Expected a successful indexed search page");
      }
      const warningCodes = result.warnings.map(({ code }) => code);
      expect(warningCodes.includes("partial_matches_appended")).toBe(
        strictHitCount === 0,
      );
      expect(warningCodes).not.toContain("no_hits");
      expect(warningCodes).not.toContain("no_hits_filtered");
      // The strict engine deliberately returns no candidate in the zero case;
      // the lower-scored partial hit covers four terms and must rank first,
      // even when its excerpt omits those terms or is absent.
      expect(scans).toBe(strictHitCount === 0 ? 2 : 1);
      expect(
        result.hits.map(({ decisionId, match }) => ({ decisionId, match })),
      ).toEqual(
        strictHitCount === 0
          ? [
              { decisionId: String(projectedId), match: "some_terms" },
              { decisionId: String(czechId), match: "some_terms" },
            ]
          : [{ decisionId: String(czechId), match: "all_terms" }],
      );
    } finally {
      scoredSpy.mockRestore();
      searchSpy.mockRestore();
      aggregateSpy.mockRestore();
      resetPublicCaseLawConfigForTesting();
      await db.delete(corpusIndexProjectionStates).where(
        and(
          inArray(
            corpusIndexProjectionStates.entityId,
            held.map(({ state }) => state.entityId),
          ),
          eq(corpusIndexProjectionStates.generation, manifest.generation),
        ),
      );
      await db.delete(corpusIndexProjectionIntents).where(
        inArray(
          corpusIndexProjectionIntents.id,
          held.map(({ intent }) => intent.id),
        ),
      );
    }
  },
);

test("Postgres relaxes an empty six-term question using whole-document term coverage", async () => {
  const db = drizzle({ client });
  const query = "promlčení nároku náhrada škody smlouva odpovědnost";
  const fixtures = [
    { id: czechId, text: "promlčení" },
    { id: projectedId, text: "promlčení nároku náhrada škody" },
  ];
  const prior = await db
    .select()
    .from(caseLawSearchDocuments)
    .where(
      inArray(
        caseLawSearchDocuments.decisionId,
        fixtures.map(({ id }) => id),
      ),
    );
  resetPublicCaseLawConfigForTesting(caseLawDb);
  try {
    await db.delete(caseLawSearchDocuments).where(
      inArray(
        caseLawSearchDocuments.decisionId,
        fixtures.map(({ id }) => id),
      ),
    );
    await db.insert(caseLawSearchDocuments).values(
      fixtures.map(({ id, text }) => ({
        decisionId: id,
        language: "cs",
        regconfig: "simple",
        searchableText: text,
        tsv: sql`to_tsvector('simple', unaccent(${text}))`,
      })),
    );
    const body = { country: "CZE", query, limit: 2 };
    const strict = await searchPostgresDecisions(
      { ...body, strict: true },
      caseLawDb,
    );
    if (!("hits" in strict)) {
      panic("Expected a successful strict Postgres search");
    }
    expect(strict.hits).toEqual([]);
    const relaxed = await searchPostgresDecisions(body, caseLawDb);
    if (!("hits" in relaxed)) {
      panic("Expected a successful relaxed Postgres search");
    }
    expect(
      relaxed.hits.map(({ decisionId, match }) => ({ decisionId, match })),
    ).toEqual([
      { decisionId: String(projectedId), match: "some_terms" },
      { decisionId: String(czechId), match: "some_terms" },
    ]);
    expect(relaxed.total).toEqual(strict.total);
    expect(relaxed.facets).toEqual(strict.facets);
    expect(relaxed.nextCursor).toBeNull();
    expect(relaxed.warnings.map(({ code }) => code)).toContain(
      "partial_matches_appended",
    );
    expect(relaxed.warnings.map(({ code }) => code)).not.toContain("no_hits");
    expect(relaxed.warnings.map(({ code }) => code)).not.toContain(
      "no_hits_filtered",
    );
    await db
      .update(caseLawSearchDocuments)
      .set({
        searchableText: query,
        tsv: sql`to_tsvector('simple', unaccent(${query}))`,
      })
      .where(eq(caseLawSearchDocuments.decisionId, czechId));
    const full = await searchPostgresDecisions(body, caseLawDb);
    if (!("hits" in full)) {
      panic("Expected a successful full-match Postgres search");
    }
    expect(
      full.hits.map(({ decisionId, match }) => ({ decisionId, match })),
    ).toEqual([{ decisionId: String(czechId), match: "all_terms" }]);
    expect(full.warnings.map(({ code }) => code)).not.toContain(
      "partial_matches_appended",
    );
  } finally {
    resetPublicCaseLawConfigForTesting();
    await db.delete(caseLawSearchDocuments).where(
      inArray(
        caseLawSearchDocuments.decisionId,
        fixtures.map(({ id }) => id),
      ),
    );
    if (prior.length > 0) {
      await db.insert(caseLawSearchDocuments).values(prior);
    }
  }
});

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

test.each([
  {
    name: "a section matches a link to one of its subsections",
    provision: { work: "262/2006 Sb.", anchor: "par_316" },
    expectedIds: [czechId],
  },
  {
    name: "a subsection matches its own links",
    provision: { work: "262/2006 Sb.", anchor: "par_316-odst_2" },
    expectedIds: [czechId],
  },
  {
    name: "a sibling subsection matches nothing",
    provision: { work: "262/2006 Sb.", anchor: "par_316-odst_1" },
    expectedIds: [],
  },
  {
    name: "a shorter section number is not a prefix of a longer one",
    provision: { work: "262/2006 Sb.", anchor: "par_31" },
    expectedIds: [slovakId],
  },
  {
    name: "the work is part of the provision",
    provision: { work: "89/2012 Sb.", anchor: "par_316" },
    expectedIds: [slovakId],
  },
  {
    name: "a section suffix the link lacks matches nothing",
    provision: { work: "262/2006 Sb.", anchor: "par_316a" },
    expectedIds: [],
  },
] as const)(
  "both indexed reads apply the provision filter: $name",
  async ({ provision, expectedIds }) => {
    const body = { ...SEARCH_BODY, provision };
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

test("a provision-only list returns citing decisions and sentences without counting the full set", async () => {
  const listed = await listCaseLawProvisionDecisions({
    body: {
      ...SEARCH_BODY,
      provision: { work: "262/2006 Sb.", anchor: "par_316" },
    },
    caseLawDb,
    dependencies: {
      servingGeneration: GENERATION,
      provider: "corpus-index",
      loadCourtWeights: async () => await Promise.resolve(courtWeights),
    },
  });
  if (!("hits" in listed)) {
    throw new Error("expected a page");
  }
  // § 316 of the labour code: the Czech decision cites odst. 2; the Slovak
  // one cites § 31 of it and § 316 of another act, so it is not listed.
  expect(listed.hits.map(({ decisionId }) => decisionId)).toEqual([
    String(czechId),
  ]);
  expect(listed.total).toEqual({ type: "not_counted" });
  expect(listed.nextCursor).toBeNull();
  expect(listed.hits.at(0)?.headline).toBe("sentence par_316-odst_2");

  const none = await listCaseLawProvisionDecisions({
    body: {
      ...SEARCH_BODY,
      provision: { work: "262/2006 Sb.", anchor: "par_317" },
    },
    caseLawDb,
    dependencies: {
      servingGeneration: GENERATION,
      provider: "corpus-index",
      loadCourtWeights: async () => await Promise.resolve(courtWeights),
    },
  });
  expect("hits" in none ? none.total : null).toEqual({ type: "not_counted" });
});

test("a provision-only list escapes the citing sentence it shows as markup", async () => {
  const db = drizzle({ client });
  // An earlier citing sentence of the same provision, holding markup.
  const [marked] = await db
    .insert(caseLawProvisionCitations)
    .values({
      anchor: "par_316-odst_2",
      confidence: 0.9,
      decisionDate: "2024-01-01",
      decisionId: czechId,
      jurisdiction: "CZE",
      section: 316,
      subsection: "2",
      sentenceText: `<b>text</b> "a" & 'b'`,
      spanEnd: 2,
      spanStart: 1,
      unit: "section",
      workCollection: "Sb.",
      workIdentifier: "262/2006 Sb.",
      workNumber: 262,
      workYear: 2006,
    })
    .returning({ id: caseLawProvisionCitations.id });
  try {
    const listed = await listCaseLawProvisionDecisions({
      body: {
        ...SEARCH_BODY,
        provision: { work: "262/2006 Sb.", anchor: "par_316" },
      },
      caseLawDb,
      dependencies: {
        servingGeneration: GENERATION,
        provider: "corpus-index",
        loadCourtWeights: async () => await Promise.resolve(courtWeights),
      },
    });
    if (!("hits" in listed)) {
      throw new Error("expected a page");
    }
    expect(listed.hits.at(0)?.headline).toBe(
      "&lt;b&gt;text&lt;/b&gt; &quot;a&quot; &amp; &#x27;b&#x27;",
    );
  } finally {
    if (marked !== undefined) {
      await db
        .delete(caseLawProvisionCitations)
        .where(eq(caseLawProvisionCitations.id, marked.id));
    }
  }
});

test("a provision-only list under the Postgres provider says it needs corpus-index search", async () => {
  const refused = await listCaseLawProvisionDecisions({
    body: {
      ...SEARCH_BODY,
      provision: { work: "262/2006 Sb.", anchor: "par_316" },
    },
    caseLawDb,
    dependencies: { provider: "pg-fts" },
  });
  expect(refused).toMatchObject({
    code: 400,
    response: { message: expect.stringContaining("corpus-index") },
  });
});

test("a provision-only list reads its page and excerpts in one snapshot", async () => {
  const before = reads;
  await listCaseLawProvisionDecisions({
    body: {
      ...SEARCH_BODY,
      provision: { work: "262/2006 Sb.", anchor: "par_316" },
    },
    caseLawDb,
    dependencies: {
      servingGeneration: GENERATION,
      provider: "corpus-index",
      loadCourtWeights: async () => await Promise.resolve(courtWeights),
    },
  });
  // One read for ids, citing sentences and rows (one repeatable-read
  // transaction), one for the language alternates.
  expect(reads - before).toBe(2);
});

test("a provision-only list cursor resumes only the request it was issued for", async () => {
  const db = drizzle({ client });
  // A second decision citing § 316 of the labour code, so the first page of
  // one has a continuation.
  const [extra] = await db
    .insert(caseLawProvisionCitations)
    .values({
      anchor: "par_316-odst_1",
      confidence: 0.9,
      decisionDate: "2024-01-01",
      decisionId: slovakId,
      jurisdiction: "CZE",
      section: 316,
      subsection: "1",
      sentenceText: "sentence par_316-odst_1",
      spanEnd: 60,
      spanStart: 50,
      unit: "section",
      workCollection: "Sb.",
      workIdentifier: "262/2006 Sb.",
      workNumber: 262,
      workYear: 2006,
    })
    .returning({ id: caseLawProvisionCitations.id });
  try {
    const request = {
      ...SEARCH_BODY,
      provision: { work: "262/2006 Sb.", anchor: "par_316" },
      limit: 1,
    } as const;
    const list = async (
      body: Parameters<typeof listCaseLawProvisionDecisions>[0]["body"],
    ) =>
      await listCaseLawProvisionDecisions({
        body,
        caseLawDb,
        dependencies: {
          servingGeneration: GENERATION,
          provider: "corpus-index",
          loadCourtWeights: async () => await Promise.resolve(courtWeights),
        },
      });
    const first = await list(request);
    if (!("hits" in first) || first.nextCursor === null) {
      throw new Error("expected a first page with a continuation");
    }
    expect(first.total).toEqual({ type: "not_counted" });
    const cursor = first.nextCursor;

    // The same request continues, to the other decision and the end.
    const second = await list({ ...request, cursor });
    if (!("hits" in second)) {
      throw new Error("expected the second page");
    }
    expect(second.nextCursor).toBeNull();
    expect(
      [...first.hits, ...second.hits]
        .map(({ decisionId }) => decisionId)
        .toSorted(),
    ).toEqual([String(czechId), String(slovakId)].toSorted());

    // Every changed filter, and a foreign string, is refused.
    for (const change of [
      { category: "B" },
      { hasLegalSentence: false },
      { court: "Nejvyšší správní soud" },
      { language: "sk" },
      { sort: "newest" as const },
      { provision: { work: "262/2006 Sb.", anchor: "par_317" } },
      { cursor: "not-a-list-cursor" },
    ]) {
      expect("hits" in (await list({ ...request, cursor, ...change }))).toBe(
        false,
      );
    }

    // A cursor of this very request whose key no longer fits the order's
    // column is refused as a cursor, never sent to the comparison.
    const [cursorContext, , cursorId] = decodePaginationCursor(cursor) ?? [];
    if (typeof cursorContext !== "string" || typeof cursorId !== "string") {
      throw new TypeError("expected a context and an id in the cursor");
    }
    for (const key of ["not-an-authority", Number.POSITIVE_INFINITY, null]) {
      const tampered = encodePaginationCursor([cursorContext, key, cursorId]);
      expect("hits" in (await list({ ...request, cursor: tampered }))).toBe(
        false,
      );
    }
    // Both decisions are undated, and `newest` lists them, in its last band.
    const newest = await list({ ...request, sort: "newest" });
    if (!("hits" in newest) || newest.nextCursor === null) {
      throw new Error("expected a newest first page with a continuation");
    }
    const [newestContext, newestDate, newestId] =
      decodePaginationCursor(newest.nextCursor) ?? [];
    expect(newestDate).toBeNull();
    const newestRest = await list({
      ...request,
      sort: "newest",
      cursor: newest.nextCursor,
    });
    if (!("hits" in newestRest)) {
      throw new Error("expected the newest second page");
    }
    expect(
      [...newest.hits, ...newestRest.hits]
        .map(({ decisionId }) => decisionId)
        .toSorted(),
    ).toEqual([String(czechId), String(slovakId)].toSorted());
    if (typeof newestContext !== "string" || typeof newestId !== "string") {
      throw new TypeError("expected a context and an id in the cursor");
    }
    for (const key of [7, "2024-13-45", "yesterday"]) {
      const tampered = encodePaginationCursor([newestContext, key, newestId]);
      expect(
        "hits" in
          (await list({ ...request, sort: "newest", cursor: tampered })),
      ).toBe(false);
    }
  } finally {
    if (extra !== undefined) {
      await db
        .delete(caseLawProvisionCitations)
        .where(eq(caseLawProvisionCitations.id, extra.id));
    }
  }
});

test("a sparse broad provision walk resumes from its bounded examined candidates", async () => {
  const db = drizzle({ client });
  await db
    .update(caseLawDecisions)
    .set({ citationAuthority: 3 })
    .where(eq(caseLawDecisions.id, slovakId));
  const examined: number[] = [];
  const request = {
    ...SEARCH_BODY,
    provision: { work: "262/2006 Sb.", anchor: "par_316" },
    limit: 1,
  } as const;
  const list = async (cursor?: string) =>
    await listCaseLawProvisionDecisions({
      body: { ...request, ...(cursor === undefined ? {} : { cursor }) },
      caseLawDb,
      dependencies: {
        candidateBudget: 1,
        provisionIdSetMax: 0,
        reportExaminedCandidates: (count) => {
          examined.push(count);
        },
        servingGeneration: GENERATION,
        provider: "corpus-index",
        loadCourtWeights: async () => await Promise.resolve(courtWeights),
      },
    });
  try {
    const first = await list();
    if (!("hits" in first) || first.nextCursor === null) {
      throw new Error("expected an empty bounded page with a continuation");
    }
    expect(first.hits).toEqual([]);
    const second = await list(first.nextCursor);
    if (!("hits" in second)) {
      throw new Error("expected the resumed page");
    }
    expect(second.hits.map(({ decisionId }) => decisionId)).toEqual([
      String(czechId),
    ]);
    expect(examined).toEqual([1, 1]);
  } finally {
    await db
      .update(caseLawDecisions)
      .set({ citationAuthority: 1 })
      .where(eq(caseLawDecisions.id, slovakId));
  }
});

// The planner picks the decision-id or the work-subtree index by the data's
// shape; either probes the provision's own links. Neither scans the table,
// and neither walks every link of the act, which for a civil code is
// millions of rows.
test("the provision filter reads links through an index, never by scanning them", async () => {
  await caseLawDb(async (tx) => {
    await tx.execute(sql`SET LOCAL enable_seqscan = off`);
    const options = {
      body: {
        ...SEARCH_BODY,
        provision: {
          work: "262/2006 Sb.",
          anchor: "par_316-odst_2",
          subsection: "2",
        },
      },
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
        /Index (?:Only )?Scan using case_law_provision_citations_decision_work_subtree_idx/u,
      );
      expect(plan).not.toContain("Seq Scan on case_law_provision_citations");
    }
  });
});

test("every decision citing a provision is read from the provision's own anchor range, not the whole act", async () => {
  await caseLawDb(async (tx) => {
    await tx.execute(sql`SET LOCAL enable_seqscan = off`);
    const plan = JSON.stringify(
      await tx.execute(
        sql`EXPLAIN (COSTS OFF) ${provisionScopeLinksQuery(tx, {
          jurisdiction: "CZE",
          // § 2910 písm. a): a level below a gap is compared within the
          // seek, never in place of it.
          provision: { work: "89/2012 Sb.", anchor: "par_2910", letter: "a" },
        }).getSQL()}`,
      ),
    );
    expect(plan).toMatch(
      /Index (?:Only )?Scan using case_law_provision_citations_work_citing_idx/u,
    );
    // The anchor bounds are the seek, not a filter over the act's links.
    // One plan row per object: `[^}]` keeps the match inside the row.
    expect(plan).toMatch(/Index Cond: [^}]*anchor[^}]*>=/u);
    expect(plan).not.toContain("case_law_provision_citations_work_idx");
  });
});

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
          /(?:Index(?: Only)? Scan using|Bitmap Index Scan on) case_law_decisions_(?:pkey|search_candidate(?:_published)?_idx)/u,
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

test("rehydration counts ids absent from the published surface as exclusions in one read", async () => {
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
    excluded: 4,
    drift: 0,
  });
  await rehydrateCaseLawCandidates(options);
  expect(hitDispositions.snapshot()).toEqual({
    malformed: 0,
    excluded: 4,
    drift: 0,
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
    excluded: 3,
    drift: 0,
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
    excluded: 3,
    drift: 0,
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
    // The published view exposes neither hidden nor absent decisions.
    // Both produce explicit null rows and an id-only exclusion.
    for (const read of partitions) {
      expect(read.rows.map((row) => row.id)).toEqual([czechId]);
      expect(read.dispositions).toEqual(
        expect.arrayContaining([
          { id: closedId, type: "excluded" },
          { id: queuedId, type: "excluded" },
          { id: missingId, type: "excluded" },
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
  const restoreFetch = installCorpusDispositionScan([
    { id: closedId, revision: closedIntentId },
    { id: missingId, revision: createSafeId<"corpusIndexProjectionIntent">() },
    { id: czechId, revision: czechIntentId },
    { id: slovakId, revision: slovakIntentId },
  ]);
  const candidateCounts: number[] = [];
  const eligibleCounts: number[] = [];
  try {
    const page = await readCorpusIndexSearchPage({
      scanTransport: NATIVE_SCAN_TRANSPORT,
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
      rankCandidates: async (candidates, { selectAppliedCandidates }) => {
        candidateCounts.push(candidates.length);
        const result = await rankCorpusIndexProviderCandidates({
          generation: GENERATION,
          caseLawDb,
          hitDispositions,
          candidates,
          excludedGroups: undefined,
          selectAppliedCandidates,
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
      excluded: 2,
      drift: 0,
    });
    expect(reads).toBe(3);
  } finally {
    restoreFetch();
  }
});

test("index search hits carry source text disposition and retain human excerpts", async () => {
  const byId = await readCaseLawPageDecisionRows({
    body: SEARCH_BODY,
    caseLawDb,
    generation: GENERATION,
    ids: [czechId, withheldId],
  });
  const page = decisionHitsPage({
    alternatesByGroupKey: { alternatesFor: () => [] },
    anchorIdById: new Map(),
    byId,
    courtWeights,
    facets: null,
    headnotePresentation: undefined,
    nextCursor: null,
    pageRanked: [czechId, withheldId].map((id) => ({
      id,
      score: 1,
      lexicalScore: 1,
      citationAuthority: 0,
    })),
    passageCountById: new Map(),
    snippetById: new Map([[withheldId, "sampleword excerpt"]]),
    // The excerpt was read from the revision the row holds, so it is current.
    snippetRevisionById: new Map(
      [...byId].flatMap(([id, row]) =>
        row.appliedRevision === null
          ? []
          : [[id, row.appliedRevision] as const],
      ),
    ),
    total: SEARCH_TOTAL_NOT_COUNTED,
    match: "all_terms",
  });
  expect(
    page.hits.map(({ decisionId, textWithheldReason }) => ({
      decisionId,
      textWithheldReason,
    })),
  ).toEqual([
    { decisionId: czechId, textWithheldReason: null },
    { decisionId: withheldId, textWithheldReason: "source_licence" },
  ]);
  expect(page.hits.find((hit) => hit.decisionId === withheldId)?.headline).toBe(
    "sampleword excerpt",
  );
});

test("full text search reads the source permission beside human excerpts", async () => {
  const plan = caseLawSearchPlan({
    body: { country: "CZE", query: "sampleword" },
    configs: [
      {
        languages: ["cs"],
        regconfig: "simple",
        includeDefault: false,
        useUnaccent: false,
      },
    ],
    courtWeights,
    excerpt: DEFAULT_SEARCH_EXCERPT,
    limit: 10,
    parsedCursor: null,
    queryUsed: "sampleword",
    sort: DEFAULT_SEARCH_SORT,
  });
  const result = await withPublicLawReaderRole(
    drizzle({ client }),
    async (tx) => await tx.execute(plan.hits),
  );
  const rows = result.rows;
  const dispositions = new Map(
    rows.map((row) => [row["decision_id"], row["allows_derived_ai"]]),
  );
  expect(dispositions.get(czechId)).toBe(true);
  expect(dispositions.get(withheldId)).toBe(false);
  expect(
    rows.find((row) => row["decision_id"] === withheldId)?.["headline"],
  ).toContain("sampleword");
});

test.each(["off", "bm25-ratio"] as const)(
  "applied revision alone supplies query matches and candidate scores in %s scans",
  async (rankingMode) => {
    const oldRevision = createSafeId<"corpusIndexProjectionIntent">();
    const oldText = "obsolete common common common common";
    const currentText = "current common";
    expect(oldRevision).not.toBe(czechIntentId);
    expect(oldText).not.toBe(currentText);
    expect(currentText).not.toContain("obsolete");
    const restoreFetch = installCorpusRevisionScan([
      { id: czechId, revision: oldRevision, text: oldText },
      { id: czechId, revision: czechIntentId, text: currentText },
      { id: withheldId, revision: withheldIntentId, text: "common common" },
    ]);
    try {
      const search = async (query: string) =>
        await readCorpusIndexSearchPage({
          observer: "unobserved",
          cluster: "q09",
          indexId: INDEX_ID,
          query: `text:${query}`,
          limit: 40,
          order: RELEVANCE_ORDER,
          parsedCursor: null,
          rankingMode,
          scanTransport:
            rankingMode === "bm25-ratio"
              ? { type: "scored" }
              : { type: "native" },
          snippetFields: ["text"],
          projectionRevisionField: "projection_revision",
          extractId: (hit) =>
            typeof hit["document_id"] === "string" ? hit["document_id"] : null,
          extractSnippet: () => null,
          unseenScoreUpperBound: () => 0,
          rankCandidates: async (candidates, scope) =>
            await rehydrateCaseLawCandidates({
              body: { country: "CZE", query, sort: "newest" },
              caseLawDb,
              courtWeights,
              generation: GENERATION,
              candidates,
              selectAppliedCandidates: scope.selectAppliedCandidates,
            }),
        });
      const obsolete = await search("obsolete");
      expect(obsolete.scan.passagesScanned).toBe(1);
      expect(reads).toBe(1);
      expect(obsolete.pageRanked).toEqual([]);
      const common = await search("common");
      expect(common.scan.passagesScanned).toBe(3);
      expect(reads).toBe(2);
      expect(common.pageRanked.map(({ id }) => id)).toEqual([
        withheldId,
        czechId,
      ]);
      const applied = common.pageRanked.find(({ id }) => id === czechId);
      expect(applied?.lexicalScore).toBeCloseTo(
        rankingMode === "off"
          ? corpusIndexLexicalScore(2)
          : (1 / 4) ** CORPUS_BM25_RATIO_POWER,
        10,
      );
      expect(common.passageCountById.get(czechId)).toBe(1);
      expect(common.passageClauseById.get(czechId)).toContain("passage-1");
    } finally {
      restoreFetch();
    }
  },
);

test.each([
  {
    name: "publisher summary alone",
    payload: {
      fulltext: null,
      textS3Key: null,
      normalizedS3Key: null,
      astS3Key: null,
    },
    expected: "metadata_only",
  },
  {
    name: "empty document",
    payload: {
      fulltext: "",
      textS3Key: null,
      normalizedS3Key: null,
      astS3Key: null,
    },
    expected: "metadata_only",
  },
  {
    name: "stored text",
    payload: {
      fulltext: "sampleword decision text",
      textS3Key: null,
      normalizedS3Key: null,
      astS3Key: null,
    },
    expected: "available",
  },
  {
    name: "completed object-storage document",
    payload: {
      fulltext: null,
      textS3Key: "text-key",
      normalizedS3Key: "normalized-key",
      astS3Key: "ast-key",
    },
    expected: "available",
  },
] as const)(
  "search reports text availability for $name on both providers",
  async ({ payload, expected }) => {
    const db = drizzle({ client });
    await db
      .update(caseLawDecisions)
      .set({
        ...payload,
        metadata: { legalSentence: "sampleword publisher summary" },
      })
      .where(eq(caseLawDecisions.id, czechId));
    const byId = await readCaseLawPageDecisionRows({
      body: SEARCH_BODY,
      caseLawDb,
      generation: GENERATION,
      ids: [czechId],
    });
    const page = decisionHitsPage({
      alternatesByGroupKey: { alternatesFor: () => [] },
      anchorIdById: new Map(),
      byId,
      courtWeights,
      facets: null,
      headnotePresentation: undefined,
      nextCursor: null,
      pageRanked: [
        { id: czechId, score: 1, lexicalScore: 1, citationAuthority: 0 },
      ],
      passageCountById: new Map(),
      snippetById: new Map(),
      snippetRevisionById: new Map(),
      total: SEARCH_TOTAL_NOT_COUNTED,
      match: "all_terms",
    });
    expect(page.hits.map((hit) => hit.textAvailability)).toEqual([expected]);
    expect(page.hits.at(0)?.headnote.type).toBe("present");
    resetPublicCaseLawConfigForTesting(caseLawDb);
    try {
      const postgres = await searchPostgresDecisions(
        { country: "CZE", query: "sampleword" },
        caseLawDb,
      );
      if (!("hits" in postgres)) {
        panic("Expected a successful Postgres search");
      }
      expect(
        postgres.hits.find((hit) => hit.decisionId === czechId)
          ?.textAvailability,
      ).toBe(expected);
    } finally {
      resetPublicCaseLawConfigForTesting();
    }
  },
);
