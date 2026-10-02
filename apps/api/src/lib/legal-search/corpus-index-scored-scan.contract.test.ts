import { panic } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { DocumentAst } from "@stll/legal-ast/document-ast";

import { envBase } from "@/api/env-base";
import { toSafeId } from "@/api/lib/branded-types";
import { withCaseLawDatedDecisions } from "@/api/lib/legal-search/case-law-dated-decisions";
import {
  type CorpusIndexHit,
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
import {
  CORPUS_BM25_PASSAGE_LIMIT,
  type CorpusIndexRankingMode,
} from "@/api/lib/legal-search/corpus-ranking-policy";
import { RELEVANCE_ORDER } from "@/api/lib/legal-search/corpus-search-order";
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
const REVISION = toSafeId<"corpusIndexProjectionIntent">(
  "0198e331-e578-7000-8000-000000000001",
);
const SOURCE_ID = "0198e331-e578-7000-8000-000000000002";
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
  return buildCaseLawProjectionDocuments({
    manifest: MANIFEST,
    input,
    payload: {
      text: ast.blocks.map((block) => block.plainText).join("\n\n"),
      ast,
    },
    revision: REVISION,
  });
};

/** The engine query the search handler builds for an entry, relevance order. */
const handlerQuery = (text: string): string => {
  const fields = caseLawCorpusQueryFields({
    generation: MANIFEST.generation,
    jurisdiction: "SVK",
    language: undefined,
  });
  const query = caseLawCorpusQuery({
    jurisdiction: "SVK",
    text,
    filters: { jurisdiction: "SVK" },
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

/** The same page through the scored endpoint, with the scan's projection. */
const readScored = async (query: string, from: number, size: number) => {
  const result = await client.scoredSearch({
    observer: "unobserved",
    indexId: INDEX_ID,
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
};

const readScanPage = async ({
  query,
  parsedCursor,
  scanTransport,
  rankingMode = "off",
}: ReadScanPageOptions) =>
  await readCorpusIndexSearchPage({
    observer: "unobserved",
    cluster: "q09",
    indexId: INDEX_ID,
    query,
    limit: 20,
    order: RELEVANCE_ORDER,
    parsedCursor,
    scanTransport,
    rankingMode,
    snippetFields: ["text"],
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
      ranked: blendStableCitationAuthority({
        candidates,
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
    }, ENGINE_TIMEOUT_MS);

    afterAll(async () => {
      await client.deleteIndex(INDEX_ID, "unobserved");
    }, ENGINE_TIMEOUT_MS);

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
            readScored(query, from, PAGE_SIZE),
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
        const universe = await readScored(query, 0, CORPUS_BM25_PASSAGE_LIMIT);
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
            scanTransport: { type: "scored", fields: ["document_id"] },
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
