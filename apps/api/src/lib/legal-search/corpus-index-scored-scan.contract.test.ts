import { panic, Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fc from "fast-check";
import { Buffer } from "node:buffer";

import type { DocumentAst } from "@stll/legal-ast/document-ast";
import { assertProperty } from "@stll/property-testing";

import { envBase } from "@/api/env-base";
import { toSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { withCaseLawDatedDecisions } from "@/api/lib/legal-search/case-law-dated-decisions";
import {
  type CorpusIndexHit,
  CORPUS_INDEX_ENGINE_INGEST_MAX_BYTES,
  getCorpusIndexClient,
} from "@/api/lib/legal-search/corpus-index-client";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexConfigFromManifest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import {
  type CorpusIndexScanTransport,
  NATIVE_SCAN_TRANSPORT,
  readCorpusIndexSearchPage,
  type SearchCursor,
} from "@/api/lib/legal-search/corpus-index-pagination";
import { buildCaseLawProjectionDocuments } from "@/api/lib/legal-search/corpus-index-projection-builder";
import type { CaseLawProjectionInput } from "@/api/lib/legal-search/corpus-index-projection-descriptor";
import { caseLawCorpusQueryFields } from "@/api/lib/legal-search/corpus-index-read-contract";
import { caseLawCorpusQuery } from "@/api/lib/legal-search/corpus-query";
import type { CorpusIndexQueryVariant } from "@/api/lib/legal-search/corpus-query-variant-policy";
import {
  CORPUS_BM25_PASSAGE_LIMIT,
  type CorpusIndexRankingMode,
} from "@/api/lib/legal-search/corpus-ranking-policy";
import {
  corpusSearchGroupToken,
  decodeCorpusSearchCursor,
  encodeCorpusSearchCursor,
} from "@/api/lib/legal-search/corpus-search-cursor";
import { RELEVANCE_ORDER } from "@/api/lib/legal-search/corpus-search-order";
import { NO_EXPANSION_DICTIONARY_IDENTITY } from "@/api/lib/legal-search/morphology/dictionary";
import {
  blendStableCitationAuthority,
  DEFAULT_AUTHORITY_WEIGHT,
  stableBlendUpperBound,
} from "@/api/lib/legal-search/rerank";

/**
 * The scored transport against the engine itself.
 *
 * The scan's golden test proves the scan derives the same pages from the same
 * engine order through either transport; it cannot prove the two endpoints
 * return the same order, because its fake serves both. This suite indexes a
 * small corpus into the pinned engine and compares the two endpoints directly.
 *
 * Opt-in: set STELLA_RUN_CORPUS_ENGINE_TESTS=true with the engine version the
 * q09 manifest pins (the `quickwit09` compose image) serving its REST API at
 * both endpoints the test environment configures (127.0.0.1:7290 for
 * mutations, 127.0.0.1:7291 for search). The suite creates and deletes its own
 * index.
 */
const runEngineTests = process.env["STELLA_RUN_CORPUS_ENGINE_TESTS"] === "true";

const MANIFEST = CORPUS_INDEX_MANIFESTS.case_law_v7;
const INDEX_ID = `case_law_v7_contract_${Date.now().toString(36)}`;
const TIED_INDEX_ID = `${INDEX_ID}_tied`;
const PROVISION_INDEX_ID = `${INDEX_ID}_provision`;
const REVISION = toSafeId<"corpusIndexProjectionIntent">(
  "0198e331-e578-7000-8000-000000000001",
);
const SOURCE_ID = "0198e331-e578-7000-8000-000000000002";
const SMALL_TIED_SOURCE_ID = "0198e331-e578-7000-8000-000000000003";
const PROVISION_SOURCE_ID = "0198e331-e578-7000-8000-000000000004";
const PROVISION_ALIAS_DOCUMENT_ID = "0398e331-e578-7000-8000-000000000001";
const PROVISION_OTHER_ACT_DOCUMENT_ID = "0398e331-e578-7000-8000-000000000002";
const ENGINE_TIMEOUT_MS = 120_000;

/**
 * Batches ingested one commit each, so each is its own split. Every batch has
 * the same composition, so its term statistics are the same and equal
 * passages score equally across splits as well as within one: the ties are
 * deliberate, and the order between them is the engine's tie-break.
 */
const BATCHES = 8;
const DECISIONS_PER_BATCH = 48;
const PASSAGES_PER_DECISION = 3;
const TIED_DOCUMENT_COUNT = CORPUS_BM25_PASSAGE_LIMIT + 104;
const SMALL_TIED_DOCUMENT_COUNT = 60;
const tiedDocumentId = (serial: number): string =>
  `0298e331-e578-7000-8000-${String(serial).padStart(12, "0")}`;

/** A block long enough that the chunker gives it a passage of its own. */
const PASSAGE_MIN_CHARS = 1100;
const SENTENCES = [
  "Žalobca sa domáhal náhrady škody spôsobenej porušením zmluvnej povinnosti.",
  "Súd posúdil nárok na náhradu škody podľa § 420 Občianskeho zákonníka.",
  "Plnenie bez právneho dôvodu zakladá bezdôvodné obohatenie podľa § 451 Občianskeho zákonníka.",
  "Kto sa na úkor iného bezdôvodne obohatí, musí obohatenie vydať.",
  "Odvolací súd rozsudok súdu prvej inštancie potvrdil ako vecne správny.",
  "Dovolanie žalovaného bolo odmietnuté ako neprípustné.",
];
const FILLER = "Konanie prebiehalo pred okresným súdom.";

const passageText = (template: number): string => {
  const sentence = SENTENCES[template % SENTENCES.length] ?? FILLER;
  const parts: string[] = [];
  let length = 0;
  while (length < PASSAGE_MIN_CHARS) {
    parts.push(sentence, FILLER);
    length += sentence.length + FILLER.length + 2;
  }
  return parts.join(" ");
};

const decisionAst = (templates: readonly number[]): DocumentAst => ({
  version: 1,
  source: {
    system: "test",
    documentId: "contract",
    webUrl: "https://example.test/contract",
    printUrl: "https://example.test/contract.pdf",
  },
  metadata: {
    caseNumber: null,
    ecli: null,
    court: null,
    decisionDate: null,
    decisionType: null,
    keywords: [],
    statutes: [],
  },
  blocks: templates.map((template, index) => {
    const text = passageText(template);
    return {
      id: `p${index}`,
      anchorId: `p${index}`,
      type: "paragraph",
      role: "argumentation",
      inlines: [{ type: "text", text }],
      plainText: text,
    };
  }),
});

/** Mirror the applied projection count from the exact documents ingested below. */
const physicalPassagesByDocument = new Map<string, number>();

const decisionDocuments = (batch: number, slot: number) => {
  const serial = batch * DECISIONS_PER_BATCH + slot;
  const templates = Array.from(
    { length: PASSAGES_PER_DECISION },
    (_, index) => (slot + index * (slot % 4)) % SENTENCES.length,
  );
  const ast = decisionAst(templates);
  const input = {
    family: "case_law",
    documentId: `0198e331-e578-7000-8000-${String(serial).padStart(12, "0")}`,
    sourceId: SOURCE_ID,
    jurisdiction: "SVK",
    language: "sk",
    documentType: "rozsudok",
    contentHash: "a".repeat(64),
    redistributionEligible: true,
    redacted: false,
    listingOnly: false,
    caseNumber: `${String(slot + 1)} Cdo ${String(batch + 1)}/2020`,
    identifiers: [],
    court: "Najvyšší súd Slovenskej republiky",
    courtId: null,
    decisionDate: `2020-01-${String((slot % 28) + 1).padStart(2, "0")}`,
    ecli: null,
    metadata: null,
  } satisfies CaseLawProjectionInput;
  const documents = buildCaseLawProjectionDocuments({
    manifest: MANIFEST,
    input,
    payload: {
      text: ast.blocks.map((block) => block.plainText).join("\n\n"),
      ast,
    },
    revision: REVISION,
  });
  physicalPassagesByDocument.set(input.documentId, documents.length);
  return documents;
};

const tiedDocuments = (serial: number) => {
  const input = {
    family: "case_law",
    documentId: tiedDocumentId(serial),
    sourceId:
      serial < SMALL_TIED_DOCUMENT_COUNT ? SMALL_TIED_SOURCE_ID : SOURCE_ID,
    jurisdiction: "CZE",
    language: "cs",
    documentType: null,
    contentHash: null,
    redistributionEligible: true,
    redacted: false,
    listingOnly: false,
    caseNumber: "",
    identifiers: [],
    court: "",
    courtId: null,
    decisionDate: null,
    ecli: null,
    metadata: null,
  } satisfies CaseLawProjectionInput;
  const documents = buildCaseLawProjectionDocuments({
    manifest: MANIFEST,
    input,
    payload: { text: "tie", ast: null },
    revision: REVISION,
  });
  expect(documents).toHaveLength(1);
  physicalPassagesByDocument.set(input.documentId, documents.length);
  return documents;
};

const provisionDocuments = () =>
  [
    {
      documentId: PROVISION_ALIAS_DOCUMENT_ID,
      text: "Podľa § 451 OZ vzniká bezdôvodné obohatenie pri plnení bez právneho dôvodu.",
    },
    {
      documentId: PROVISION_OTHER_ACT_DOCUMENT_ID,
      text: "Podľa § 451 Občianskeho súdneho poriadku súd posúdil bezdôvodné obohatenie. Výklad zákonníka uviedol oddelene.",
    },
  ].flatMap(({ documentId, text }) =>
    buildCaseLawProjectionDocuments({
      manifest: MANIFEST,
      input: {
        family: "case_law",
        documentId,
        sourceId: PROVISION_SOURCE_ID,
        jurisdiction: "SVK",
        language: "sk",
        documentType: "rozsudok",
        contentHash: null,
        redistributionEligible: true,
        redacted: false,
        listingOnly: false,
        caseNumber: "",
        identifiers: [],
        court: "",
        courtId: null,
        decisionDate: "2020-01-01",
        ecli: null,
        metadata: null,
      },
      payload: { text, ast: null },
      revision: REVISION,
    }),
  );

type HandlerQueryOptions = {
  queryVariant?: CorpusIndexQueryVariant;
  source?: string;
};

/** The engine query the search handler builds for an entry, relevance order. */
const handlerQuery = (
  text: string,
  { queryVariant, source }: HandlerQueryOptions = {},
): string => {
  const fields = caseLawCorpusQueryFields({
    generation: MANIFEST.generation,
    jurisdiction: "SVK",
    language: undefined,
  });
  const query = caseLawCorpusQuery({
    jurisdiction: "SVK",
    text,
    filters: { jurisdiction: "SVK", source },
    queryVariant,
    stemming: fields.stemming,
    surfaceFields: fields.surfaceFields,
    keywordFields: fields.keywordFields,
    functionWords: fields.functionWords,
  });
  if (query === null) {
    throw new Error(`the entry ${text} built no engine query`);
  }
  return withCaseLawDatedDecisions(query, "relevance");
};

const ENTRIES = [
  ["term", "náhrada škody"],
  ["phrase", '"bezdôvodné obohatenie"'],
  ["provision", "§ 451 Občianskeho zákonníka"],
] as const;

const client = getCorpusIndexClient("q09");

/** A hit as the scan identifies it: its document, passage and anchor. */
const passageKey = (hit: CorpusIndexHit) => [
  hit["document_id"] ?? null,
  hit["chunk_id"] ?? null,
  hit["anchor_id"] ?? null,
];

const PAGE_SIZE = 50;

/** Every hit, page by page, through the native endpoint as the scan asks. */
const readNative = async (query: string, from: number, size: number) => {
  const result = await client.search({
    observer: "unobserved",
    indexId: INDEX_ID,
    query,
    maxHits: size,
    startOffset: from,
    sortBy: "_score",
  });
  if (result.isErr()) {
    throw result.error;
  }
  return result.value;
};

type ReadScoredOptions = {
  query: string;
  from: number;
  size: number;
  indexId?: string;
};

/** The same page through the scored endpoint, with the scan's projection. */
const readScored = async ({
  query,
  from,
  size,
  indexId = INDEX_ID,
}: ReadScoredOptions) => {
  const result = await client.scoredSearch({
    observer: "unobserved",
    indexId,
    query,
    from,
    size,
    fields: ["document_id", "chunk_id", "anchor_id"],
    requiredFields: ["document_id"],
  });
  if (result.isErr()) {
    throw result.error;
  }
  return result.value;
};

type ReadScanPageOptions = {
  query: string;
  parsedCursor: SearchCursor | null;
  scanTransport: CorpusIndexScanTransport;
  rankingMode?: CorpusIndexRankingMode;
  limit?: number;
  indexId?: string;
};

const readScanPage = async ({
  query,
  parsedCursor,
  scanTransport,
  rankingMode = "off",
  limit = 20,
  indexId = INDEX_ID,
}: ReadScanPageOptions) =>
  await readCorpusIndexSearchPage({
    observer: "unobserved",
    cluster: "q09",
    indexId,
    query,
    limit,
    order: RELEVANCE_ORDER,
    parsedCursor,
    scanTransport,
    rankingMode,
    snippetFields: ["text"],
    projectionRevisionField: "projection_revision",
    extractId: (hit) =>
      typeof hit["document_id"] === "string" ? hit["document_id"] : null,
    extractSnippet: (snippet) => {
      const text = snippet?.["text"];
      return Array.isArray(text) ? String(text.at(0)) : null;
    },
    unseenScoreUpperBound: (next) =>
      stableBlendUpperBound(next, DEFAULT_AUTHORITY_WEIGHT),
    rankCandidates: async (candidates) => ({
      context: null,
      // Every fixture document was ingested under this one revision.
      revisionById: new Map(candidates.map(({ id }) => [id, REVISION])),
      groups: candidates
        .filter(({ id }) => {
          const count = physicalPassagesByDocument.get(id);
          if (count === undefined) {
            return panic("Candidate has no ingested projection count");
          }
          return count > 1;
        })
        .map(({ id }) => corpusSearchGroupToken(id)),
      ranked: blendStableCitationAuthority({
        candidates: candidates.filter(
          (candidate) =>
            !parsedCursor?.excludedGroups?.includes(
              corpusSearchGroupToken(candidate.id),
            ),
        ),
        authorityById: new Map(),
      }),
    }),
  });

describe.skipIf(!runEngineTests)(
  "the scored endpoint against the pinned engine",
  () => {
    beforeAll(async () => {
      const created = await client.createIndex(
        corpusIndexConfigFromManifest(MANIFEST, INDEX_ID),
        "unobserved",
      );
      if (created.isErr()) {
        throw created.error;
      }
      // `force` commits each batch at once, so each becomes its own split;
      // the client's committed ingest waits out the commit timeout instead.
      const mutationBase =
        envBase.CORPUS_INDEX_Q09_ENDPOINT ??
        envBase.CORPUS_INDEX_Q09_SEARCH_ENDPOINT;
      for (let batch = 0; batch < BATCHES; batch += 1) {
        const ndjson = Array.from({ length: DECISIONS_PER_BATCH }, (_, slot) =>
          decisionDocuments(batch, slot),
        )
          .flat()
          .map((document) => JSON.stringify(document))
          .join("\n");
        // Sequential on purpose: one commit, so one split, per batch.
        const response = await fetch(
          `${String(mutationBase)}/api/v1/${INDEX_ID}/ingest?commit=force`,
          {
            method: "POST",
            headers: { "content-type": "application/x-ndjson" },
            body: `${ndjson}\n`,
          },
        );
        if (!response.ok) {
          throw new Error(`ingest ${String(response.status)}`);
        }
      }
      const provisionCreated = await client.createIndex(
        corpusIndexConfigFromManifest(MANIFEST, PROVISION_INDEX_ID),
        "unobserved",
      );
      if (provisionCreated.isErr()) {
        throw provisionCreated.error;
      }
      // Its own index: the ENTRIES scans rank every candidate they reach, and
      // these documents carry no projection count and no batch composition.
      const provisionResponse = await fetch(
        `${String(mutationBase)}/api/v1/${PROVISION_INDEX_ID}/ingest?commit=force`,
        {
          method: "POST",
          headers: { "content-type": "application/x-ndjson" },
          body: `${provisionDocuments()
            .map((document) => JSON.stringify(document))
            .join("\n")}\n`,
        },
      );
      if (!provisionResponse.ok) {
        throw new Error(`ingest ${String(provisionResponse.status)}`);
      }
      const tiedCreated = await client.createIndex(
        corpusIndexConfigFromManifest(MANIFEST, TIED_INDEX_ID),
        "unobserved",
      );
      if (tiedCreated.isErr()) {
        throw tiedCreated.error;
      }
      // One isolated split gives every identical passage the same BM25 term
      // statistics; the ordinary multi-split fixtures must not affect them.
      const documents = Array.from(
        { length: TIED_DOCUMENT_COUNT },
        (_, serial) => tiedDocuments(serial),
      ).flat();
      expect(documents).toHaveLength(TIED_DOCUMENT_COUNT);
      const tiedNdjson = `${documents.map((document) => JSON.stringify(document)).join("\n")}\n`;
      expect(Buffer.byteLength(tiedNdjson, "utf-8")).toBeLessThanOrEqual(
        CORPUS_INDEX_ENGINE_INGEST_MAX_BYTES,
      );
      const tiedResponse = await fetch(
        `${String(mutationBase)}/api/v1/${TIED_INDEX_ID}/ingest?commit=force`,
        {
          method: "POST",
          headers: { "content-type": "application/x-ndjson" },
          body: tiedNdjson,
        },
      );
      if (!tiedResponse.ok) {
        throw new Error(`ingest ${String(tiedResponse.status)}`);
      }
    }, ENGINE_TIMEOUT_MS);

    afterAll(async () => {
      for (const indexId of [INDEX_ID, TIED_INDEX_ID, PROVISION_INDEX_ID]) {
        const deleted = await client.deleteIndex(indexId, "unobserved");
        if (deleted.isErr()) {
          throw deleted.error;
        }
      }
    }, ENGINE_TIMEOUT_MS);

    test(
      "provision variants match civil-code aliases without admitting a different act",
      async () => {
        const text = "§ 451 Občianskeho zákonníka bezdôvodné obohatenie";
        const offQuery = handlerQuery(text, {
          queryVariant: "off",
          source: PROVISION_SOURCE_ID,
        });
        const variantQuery = handlerQuery(text, {
          queryVariant: "provision-refs",
          source: PROVISION_SOURCE_ID,
        });
        expect(variantQuery).not.toBe(offQuery);
        const off = await readScored({
          query: offQuery,
          from: 0,
          size: 10,
          indexId: PROVISION_INDEX_ID,
        });
        const variant = await readScored({
          query: variantQuery,
          from: 0,
          size: 10,
          indexId: PROVISION_INDEX_ID,
        });
        const offIds = new Set(
          off.hits.map(({ fields }) => fields["document_id"]),
        );
        const variantIds = new Set(
          variant.hits.map(({ fields }) => fields["document_id"]),
        );
        expect(offIds.has(PROVISION_ALIAS_DOCUMENT_ID)).toBe(false);
        // The control reaches the old independent-word conjunction.
        expect(offIds.has(PROVISION_OTHER_ACT_DOCUMENT_ID)).toBe(true);
        expect(variantIds).toEqual(new Set([PROVISION_ALIAS_DOCUMENT_ID]));
      },
      ENGINE_TIMEOUT_MS,
    );

    test(
      "all-tied scores past the cutoff fall back and visit every document once",
      async () => {
        const query = "jurisdiction:CZE AND text:tie";
        const universe = await readScored({
          query,
          from: 0,
          size: CORPUS_BM25_PASSAGE_LIMIT + 1,
          indexId: TIED_INDEX_ID,
        });
        expect(universe.numHits).toBe(TIED_DOCUMENT_COUNT);
        expect(universe.hits).toHaveLength(CORPUS_BM25_PASSAGE_LIMIT + 1);
        expect(new Set(universe.hits.map(({ score }) => score)).size).toBe(1);
        expect(universe.hits.at(0)?.score).toBeGreaterThan(0);
        await assertProperty(
          "all-tied scores past the cutoff fall back and visit every document once",
          fc.asyncProperty(
            fc.integer({ min: 200, max: 500 }),
            async (limit) => {
              let cursor: SearchCursor | null = null;
              const seen: string[] = [];
              for (
                let page = 0;
                page < TIED_DOCUMENT_COUNT / limit + 20;
                page += 1
              ) {
                const read = await readScanPage({
                  query,
                  indexId: TIED_INDEX_ID,
                  limit,
                  parsedCursor: cursor,
                  rankingMode: "bm25-ratio",
                  scanTransport: {
                    type: "scored",
                    fields: ["document_id", "chunk_id", "anchor_id"],
                  },
                });
                seen.push(...read.pageRanked.map(({ id }) => id));
                if (read.nextCursor === null) {
                  cursor = null;
                  break;
                }
                expect(read.nextCursor.rankingMode).toBe("off");
                const decoded = decodeCorpusSearchCursor(
                  encodeCorpusSearchCursor({
                    ...read.nextCursor,
                    target: null,
                    dictionary: NO_EXPANSION_DICTIONARY_IDENTITY,
                  }),
                );
                if (decoded === null) {
                  panic("Expected an encoded mode cursor");
                }
                cursor = decoded;
              }
              expect(cursor).toBeNull();
              expect(new Set(seen)).toEqual(
                new Set(
                  Array.from({ length: TIED_DOCUMENT_COUNT }, (_, serial) =>
                    tiedDocumentId(serial),
                  ),
                ),
              );
              expect(seen).toHaveLength(TIED_DOCUMENT_COUNT);
            },
          ),
          { numRuns: 3 },
        );
      },
      ENGINE_TIMEOUT_MS,
    );

    test(
      "ties below the cutoff preserve every document and the cursor mode",
      async () => {
        const query = `jurisdiction:CZE AND text:tie AND source:${SMALL_TIED_SOURCE_ID}`;
        const universe = await readScored({
          query,
          from: 0,
          size: CORPUS_BM25_PASSAGE_LIMIT + 1,
          indexId: TIED_INDEX_ID,
        });
        expect(universe.numHits).toBe(SMALL_TIED_DOCUMENT_COUNT);
        expect(new Set(universe.hits.map(({ score }) => score)).size).toBe(1);
        expect(universe.hits.at(0)?.score).toBeGreaterThan(0);
        await assertProperty(
          "ties below the cutoff preserve every document and the cursor mode",
          fc.asyncProperty(fc.integer({ min: 7, max: 25 }), async (limit) => {
            let cursor: SearchCursor | null = null;
            const seen: string[] = [];
            for (
              let page = 0;
              page < Math.ceil(SMALL_TIED_DOCUMENT_COUNT / limit);
              page += 1
            ) {
              const read = await readScanPage({
                query,
                indexId: TIED_INDEX_ID,
                limit,
                parsedCursor: cursor,
                rankingMode: "bm25-ratio",
                scanTransport: {
                  type: "scored",
                  fields: ["document_id", "chunk_id", "anchor_id"],
                },
              });
              seen.push(...read.pageRanked.map(({ id }) => id));
              if (read.nextCursor === null) {
                cursor = null;
                break;
              }
              expect(read.nextCursor.rankingMode).toBe("bm25-ratio");
              const decoded = decodeCorpusSearchCursor(
                encodeCorpusSearchCursor({
                  ...read.nextCursor,
                  target: null,
                  dictionary: NO_EXPANSION_DICTIONARY_IDENTITY,
                }),
              );
              if (decoded === null) {
                panic("Expected an encoded mode cursor");
              }
              cursor = decoded;
              if (page === 0) {
                const rejected = await Result.tryPromise(
                  async () =>
                    await readScanPage({
                      query,
                      indexId: TIED_INDEX_ID,
                      limit,
                      parsedCursor: decoded,
                      rankingMode: "off",
                      scanTransport: {
                        type: "scored",
                        fields: ["document_id"],
                      },
                    }),
                );
                expect(rejected.isErr()).toBe(true);
                if (rejected.isErr()) {
                  expect(rejected.error.cause).toBeInstanceOf(HandlerError);
                  expect(rejected.error.cause).toMatchObject({
                    status: 400,
                    message: "Invalid cursor",
                  });
                }
              }
            }
            expect(cursor).toBeNull();
            expect(new Set(seen)).toEqual(
              new Set(
                Array.from({ length: SMALL_TIED_DOCUMENT_COUNT }, (_, serial) =>
                  tiedDocumentId(serial),
                ),
              ),
            );
            expect(seen).toHaveLength(SMALL_TIED_DOCUMENT_COUNT);
          }),
          { numRuns: 3 },
        );
      },
      ENGINE_TIMEOUT_MS,
    );

    test("the corpus spans several splits", async () => {
      const response = await fetch(
        `${String(envBase.CORPUS_INDEX_Q09_ENDPOINT)}/api/v1/indexes/${INDEX_ID}/splits?split_states=Published`,
      );
      const body: unknown = await response.json();
      const splits =
        typeof body === "object" && body !== null && "splits" in body
          ? body.splits
          : null;

      expect(Array.isArray(splits) ? splits.length : 0).toBeGreaterThan(1);
    });

    test.each(ENTRIES)(
      "a %s entry pages in the same order through both endpoints",
      async (_kind, entry) => {
        const query = handlerQuery(entry);
        const native: unknown[] = [];
        const scored: unknown[] = [];
        const scores: number[] = [];
        let total = Number.POSITIVE_INFINITY;
        for (let from = 0; from < total; from += PAGE_SIZE) {
          const [nativePage, scoredPage] = await Promise.all([
            readNative(query, from, PAGE_SIZE),
            readScored({ query, from, size: PAGE_SIZE }),
          ]);
          expect(scoredPage.numHits).toBe(nativePage.numHits);
          total = nativePage.numHits;
          native.push(...nativePage.hits.map(passageKey));
          scored.push(...scoredPage.hits.map((hit) => passageKey(hit.fields)));
          scores.push(...scoredPage.hits.map((hit) => hit.score));
        }

        // Several pages, and equal scores both inside a page and across the
        // page boundaries, or the comparison says nothing about tie order.
        expect(total).toBeGreaterThan(PAGE_SIZE * 2);
        const tied = scores.filter(
          (score, index) => index > 0 && score === scores[index - 1],
        ).length;
        expect(tied).toBeGreaterThan(PAGE_SIZE);
        expect(scored).toEqual(native);
      },
      ENGINE_TIMEOUT_MS,
    );

    test.each(ENTRIES)(
      "a %s entry replays BM25 pages from the real scored universe",
      async (_kind, entry) => {
        const query = handlerQuery(entry);
        const universe = await readScored({
          query,
          from: 0,
          size: CORPUS_BM25_PASSAGE_LIMIT,
        });
        expect(universe.hits.length).toBeGreaterThan(20);
        const top = universe.hits.at(0)?.score;
        if (top === undefined || top <= 0) {
          panic("Expected a positive scored universe");
        }
        const best = new Map<string, number>();
        for (const { fields, score } of universe.hits) {
          const id = fields["document_id"];
          if (typeof id !== "string" || best.has(id)) {
            continue;
          }
          best.set(id, score);
        }
        const expected = blendStableCitationAuthority({
          candidates: [...best].map(([id, score]) => ({
            id,
            score: (score / top) ** 0.25,
          })),
          authorityById: new Map(),
        });
        const seen: string[] = [];
        let cursor: SearchCursor | null = null;
        for (let page = 0; page < Math.ceil(expected.length / 20); page += 1) {
          const read = await readScanPage({
            query,
            parsedCursor: cursor,
            scanTransport: {
              type: "scored",
              fields: ["document_id", "chunk_id", "anchor_id"],
            },
            rankingMode: "bm25-ratio",
          });
          expect(read.pageRanked).toEqual(
            expected.slice(page * 20, (page + 1) * 20),
          );
          expect(read.lexicalScores?.bestScoreById).toEqual(best);
          expect(read.scan.rounds).toBe(1);
          expect(read.scan.highlightRounds).toBe(1);
          expect(read.snippetById.size).toBeGreaterThan(0);
          seen.push(...read.pageRanked.map(({ id }) => id));
          cursor = read.nextCursor;
          if (cursor !== null) {
            expect(cursor.windowStart).toBe(0);
          }
        }
        expect(cursor).toBeNull();
        expect(seen).toEqual(expected.map(({ id }) => id));
        expect(new Set(seen).size).toBe(seen.length);
      },
      ENGINE_TIMEOUT_MS,
    );

    test.each(ENTRIES)(
      "a %s entry scans to the same pages through both transports",
      async (_kind, entry) => {
        const query = handlerQuery(entry);
        const pages = async (transport: CorpusIndexScanTransport) => {
          const out: unknown[] = [];
          let cursor: SearchCursor | null = null;
          for (let page = 0; page < 3; page += 1) {
            const read = await readScanPage({
              query,
              parsedCursor: cursor,
              scanTransport: transport,
            });
            const { indexMs: _indexMs, ...scan } = read.scan;
            out.push({
              pageRanked: read.pageRanked,
              nextCursor: read.nextCursor,
              passageCountById: [...read.passageCountById],
              anchorIdById: [...read.anchorIdById],
              snippetById: [...read.snippetById],
              scan,
            });
            cursor = read.nextCursor;
            if (cursor === null) {
              break;
            }
          }
          return out;
        };

        const native = await pages(NATIVE_SCAN_TRANSPORT);
        const scored = await pages({ type: "scored", fields: ["document_id"] });

        expect(native.length).toBeGreaterThan(1);
        expect(scored).toEqual(native);
      },
      ENGINE_TIMEOUT_MS,
    );
  },
);
