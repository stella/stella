import { afterEach, expect, test } from "bun:test";

import { createCorpusHitDispositionCounter } from "@/api/lib/legal-search/corpus-hit-telemetry";
import {
  CORPUS_INDEX_MANIFESTS,
  type CorpusIndexManifest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import {
  corpusIndexLexicalScore,
  type CorpusIndexScanTransport,
  readCorpusIndexSearchPage,
} from "@/api/lib/legal-search/corpus-index-pagination";
import { corpusAppliedProjection } from "@/api/lib/legal-search/corpus-index-revision-clause";
import {
  CORPUS_BM25_RATIO_POWER,
  type CorpusIndexRankingMode,
} from "@/api/lib/legal-search/corpus-ranking-policy";
import { RELEVANCE_ORDER } from "@/api/lib/legal-search/corpus-search-order";
import { testRevisionOf } from "@/api/tests/helpers/corpus-projection-revisions";
import { createTestFetch } from "@/api/tests/helpers/test-fetch";

const testFetchState = createTestFetch();

const originalFetch = globalThis.fetch;
afterEach(() => {
  testFetchState.restore();
});

const APPLIED_REVISION = testRevisionOf("applied");
const SUPERSEDED_REVISION = testRevisionOf("superseded");

type ReadRevisionFixtureOptions = {
  manifest: CorpusIndexManifest;
  scanTransport: CorpusIndexScanTransport;
  rankingMode: CorpusIndexRankingMode;
};

const readRevisionFixture = async ({
  manifest,
  scanTransport,
  rankingMode,
}: ReadRevisionFixtureOptions) => {
  const appliedProjection = corpusAppliedProjection(manifest, APPLIED_REVISION);
  const retrieval = appliedProjection.retrieval;
  const stored = retrieval.type === "stored";
  const passages = [
    {
      document_id: "stale-only",
      chunk_id: "stale-only-1",
      projection_revision: SUPERSEDED_REVISION,
    },
    {
      document_id: "current",
      chunk_id: "current-old",
      projection_revision: SUPERSEDED_REVISION,
    },
    {
      document_id: "current",
      chunk_id: "current-new",
      projection_revision: APPLIED_REVISION,
    },
    {
      document_id: "current",
      chunk_id: "current-new-2",
      projection_revision: APPLIED_REVISION,
    },
  ];
  const returnedHits = passages.map((passage) =>
    stored
      ? passage
      : { document_id: passage.document_id, chunk_id: passage.chunk_id },
  );
  if (stored) {
    returnedHits.push({
      document_id: "missing-revision",
      chunk_id: "missing-revision-1",
    });
  }
  const requests: Record<string, unknown>[] = [];
  const highlightQueries: string[] = [];
  const stub = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const body: Record<string, unknown> =
      typeof init?.body === "string" ? JSON.parse(init.body) : {};
    requests.push(body);
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname.includes("/_elastic/")) {
      return Response.json({
        hits: {
          total: { value: returnedHits.length, relation: "eq" },
          hits: returnedHits.map((hit, index) => ({
            _source: hit,
            sort: [10 - index],
          })),
        },
      });
    }
    if (body["snippet_fields"] !== undefined) {
      const query = String(body["query"]);
      highlightQueries.push(query);
      // A real index filters on the indexed revision even when it is not stored.
      const hits = passages
        .filter(
          (passage) =>
            passage.projection_revision === APPLIED_REVISION &&
            query.includes(APPLIED_REVISION) &&
            (query.includes(`chunk_id:"${passage.chunk_id}"`) ||
              query.includes(`document_id:"${passage.document_id}"`)),
        )
        .slice(0, Number(body["max_hits"]));
      return Response.json({
        num_hits: hits.length,
        hits: hits.map(({ document_id, chunk_id }) => ({
          document_id,
          chunk_id,
        })),
        snippets: hits.map(() => ({ text: ["applied revision text"] })),
      });
    }
    return Response.json({
      num_hits: returnedHits.length,
      hits: returnedHits,
      snippets: [],
    });
  };
  testFetchState.set(
    Object.assign(stub, {
      preconnect: originalFetch.preconnect,
    }),
  );
  const hitDispositions = createCorpusHitDispositionCounter();
  const page = await readCorpusIndexSearchPage({
    hitDispositions,
    observer: "unobserved",
    cluster: "q09",
    indexId: "revision-fixture",
    query: "text:promlčení",
    limit: 10,
    parsedCursor: null,
    scanTransport,
    rankingMode,
    order: RELEVANCE_ORDER,
    snippetFields: ["text"],
    projectionRevisionField: "projection_revision",
    extractId: (hit) =>
      typeof hit["document_id"] === "string" ? hit["document_id"] : null,
    extractSnippet: (snippet) => {
      const text = snippet?.["text"];
      return Array.isArray(text) && typeof text.at(0) === "string"
        ? text.at(0)
        : null;
    },
    unseenScoreUpperBound: () => 0,
    rankCandidates: async (probes, { selectAppliedCandidates }) => {
      const revisionById = new Map(
        probes.map(({ id }) => [id, APPLIED_REVISION]),
      );
      return {
        context: null,
        groups: [],
        revisionById,
        ranked: selectAppliedCandidates(
          new Map(probes.map(({ id }) => [id, appliedProjection])),
        ).map(({ id, score }) => ({
          id,
          score,
          lexicalScore: score,
          citationAuthority: 0,
        })),
      };
    },
  });
  return { page, requests, highlightQueries, hitDispositions, returnedHits };
};

for (const { scanTransport, rankingMode } of [
  { scanTransport: { type: "native" }, rankingMode: "off" },
  { scanTransport: { type: "scored" }, rankingMode: "off" },
  { scanTransport: { type: "scored" }, rankingMode: "bm25-ratio" },
] as const) {
  test(`legacy revision-constrained hydration accepts unstored revisions through ${scanTransport.type} search with ${rankingMode} ranking`, async () => {
    const { page, requests, highlightQueries, hitDispositions, returnedHits } =
      await readRevisionFixture({
        manifest: CORPUS_INDEX_MANIFESTS.case_law_v8,
        scanTransport,
        rankingMode,
      });
    expect(returnedHits.every((hit) => !("projection_revision" in hit))).toBe(
      true,
    );
    expect(page.pageRanked.map(({ id }) => id)).toEqual([
      "stale-only",
      "current",
    ]);
    expect(page.snippetById.get("current")).toBe("applied revision text");
    expect(page.snippetById.has("stale-only")).toBe(false);
    expect(
      highlightQueries.every((query) =>
        query.includes(`projection_revision:"${APPLIED_REVISION}"`),
      ),
    ).toBe(true);
    expect(hitDispositions.snapshot().malformed).toBe(0);
    // One scan, one batch, and existing per-document fallbacks for stale chunks.
    expect(requests).toHaveLength(4);
  });

  test(`stored revision selection rejects superseded hits through ${scanTransport.type} search with ${rankingMode} ranking`, async () => {
    const { page, requests, hitDispositions } = await readRevisionFixture({
      manifest: CORPUS_INDEX_MANIFESTS.case_law_v9,
      scanTransport,
      rankingMode,
    });
    expect(page.pageRanked.map(({ id }) => id)).toEqual(["current"]);
    expect(page.pageRanked.at(0)?.score).toBe(
      rankingMode === "bm25-ratio"
        ? (8 / 10) ** CORPUS_BM25_RATIO_POWER
        : corpusIndexLexicalScore(2),
    );
    expect(page.passageCountById.get("current")).toBe(2);
    expect(page.snippetById.get("current")).toBe("applied revision text");
    expect(page.passageClauseById.get("current")).toBe(
      'chunk_id:"current-new"',
    );
    expect(hitDispositions.snapshot().malformed).toBe(0);
    expect(requests).toHaveLength(2);
  });
}
