import { afterEach, expect, test } from "bun:test";
import fc from "fast-check";
import * as v from "valibot";

import { propertyConfig } from "@stll/property-testing";

import { envBaseServerSchema } from "@/api/env-base-schema";
import {
  readCorpusIndexSearchPage,
  type SearchCursor,
} from "@/api/lib/legal-search/corpus-index-pagination";
import {
  CORPUS_BM25_PASSAGE_LIMIT,
  corpusRankingCursorTarget,
} from "@/api/lib/legal-search/corpus-ranking-policy";
import { RELEVANCE_ORDER } from "@/api/lib/legal-search/corpus-search-order";
import { collapseByLanguageGroup } from "@/api/lib/legal-search/language-group-collapse";
import {
  blendStableCitationAuthority,
  courtTierSignal,
  stableBlendUpperBound,
} from "@/api/lib/legal-search/rerank";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const rankingTestOptions = {
  observer: "unobserved",
  cluster: "q09",
  indexId: "case_law_v7_cs_sk",
  query: "text:fiction",
  order: RELEVANCE_ORDER,
  scanTransport: { type: "scored", fields: ["document_id"] },
  limit: 40,
  parsedCursor: null,
  snippetFields: [],
  extractId: (hit) =>
    typeof hit["document_id"] === "string" ? hit["document_id"] : null,
  extractSnippet: () => null,
  unseenScoreUpperBound: stableBlendUpperBound,
  rankCandidates: async (candidates) => ({
    context: null,
    ranked: blendStableCitationAuthority({
      candidates,
      authorityById: new Map(),
    }),
  }),
} satisfies Parameters<typeof readCorpusIndexSearchPage>[0];

const stubRankingScores = (scores: readonly number[]) => {
  globalThis.fetch = Object.assign(
    async (
      _input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const body = JSON.parse(String(init?.body));
      const hits = scores.map((score, rank) => ({
        _source: {
          document_id: `doc-${rank}`,
          chunk_id: `passage-${rank}`,
          anchor_id: `anchor-${rank}`,
        },
        _score: score,
      }));
      return new Response(
        JSON.stringify({
          hits: {
            total: { value: hits.length },
            hits: hits.slice(body.from, body.from + body.size),
          },
        }),
      );
    },
    { preconnect: originalFetch.preconnect },
  );
};

const orderedPositiveScores = fc
  .array(fc.integer({ min: 1, max: 1_000_000 }), {
    minLength: 2,
    maxLength: 40,
  })
  .map((scores) => scores.toSorted((left, right) => right - left));

test("BM25 normalization preserves ordering and pages under positive score scaling", async () => {
  await fc.assert(
    fc.asyncProperty(
      orderedPositiveScores,
      fc.constantFrom(-8, -4, -1, 1, 4, 8),
      fc.integer({ min: 1, max: 6 }),
      async (scores, exponent, limit) => {
        stubRankingScores(scores);
        const first = await readCorpusIndexSearchPage({
          ...rankingTestOptions,
          rankingMode: "bm25-ratio",
          limit,
        });
        const whole = await readCorpusIndexSearchPage({
          ...rankingTestOptions,
          rankingMode: "bm25-ratio",
        });
        const lexicalScores = whole.pageRanked.map((hit) => hit.lexicalScore);
        expect(lexicalScores.at(0)).toBe(1);
        expect(lexicalScores.every((score) => score > 0 && score <= 1)).toBe(
          true,
        );
        expect(lexicalScores).toEqual(
          lexicalScores.toSorted((left, right) => right - left),
        );
        expect(new Set(whole.pageRanked.map((hit) => hit.id)).size).toBe(
          scores.length,
        );

        stubRankingScores(scores.map((score) => score * 2 ** exponent));
        const scaled = await readCorpusIndexSearchPage({
          ...rankingTestOptions,
          rankingMode: "bm25-ratio",
          limit,
        });
        expect(scaled.pageRanked).toEqual(first.pageRanked);
        expect(scaled.nextCursor).toEqual(first.nextCursor);
        if (first.nextCursor !== null) {
          const continuation = await readCorpusIndexSearchPage({
            ...rankingTestOptions,
            rankingMode: "bm25-ratio",
            limit,
            parsedCursor: first.nextCursor,
          });
          expect(continuation.pageRanked).toEqual(
            whole.pageRanked.slice(limit, limit * 2),
          );
        }
      },
    ),
    propertyConfig(),
  );
});

test("omitting the ranking flag preserves explicit OFF pages and cursors", async () => {
  await fc.assert(
    fc.asyncProperty(
      orderedPositiveScores,
      fc.integer({ min: 1, max: 6 }),
      async (scores, limit) => {
        stubRankingScores(scores);
        const options = { ...rankingTestOptions, limit };
        const defaultPage = await readCorpusIndexSearchPage(options);
        const offPage = await readCorpusIndexSearchPage({
          ...options,
          rankingMode: "off",
        });
        expect({
          ...defaultPage,
          scan: { ...defaultPage.scan, indexMs: 0 },
        }).toEqual({
          ...offPage,
          scan: { ...offPage.scan, indexMs: 0 },
        });
        if (defaultPage.nextCursor !== null) {
          const continuationOptions = {
            ...options,
            parsedCursor: defaultPage.nextCursor,
          };
          const defaultContinuation =
            await readCorpusIndexSearchPage(continuationOptions);
          const offContinuation = await readCorpusIndexSearchPage({
            ...continuationOptions,
            rankingMode: "off",
          });
          expect({
            ...defaultContinuation,
            scan: { ...defaultContinuation.scan, indexMs: 0 },
          }).toEqual({
            ...offContinuation,
            scan: { ...offContinuation.scan, indexMs: 0 },
          });
        }
      },
    ),
    propertyConfig(),
  );
});

test("an empty BM25 universe returns no page, cursor or passage metadata", async () => {
  stubRankingScores([]);
  const page = await readCorpusIndexSearchPage({
    ...rankingTestOptions,
    rankingMode: "bm25-ratio",
  });
  expect(page.pageRanked).toEqual([]);
  expect(page.nextCursor).toBeNull();
  expect(page.anchorIdById.size).toBe(0);
  expect(page.passageCountById.size).toBe(0);
  expect(page.snippetById.size).toBe(0);
  expect(page.lexicalScores?.topScore).toBeNull();
  expect(page.lexicalScores?.bestScoreById.size).toBe(0);
  expect(page.scan.passagesScanned).toBe(0);
});

test("BM25 ranking drops rejected identities before passage metadata and hydration", async () => {
  stubRankingScores([100, 80]);
  const page = await readCorpusIndexSearchPage({
    ...rankingTestOptions,
    rankingMode: "bm25-ratio",
    extractId: (hit) => (hit["document_id"] === "doc-0" ? null : "doc-1"),
  });
  expect(page.pageRanked.map((hit) => hit.id)).toEqual(["doc-1"]);
  expect(page.nextCursor).toBeNull();
  expect([...page.anchorIdById.keys()]).toEqual(["doc-1"]);
  expect([...page.passageCountById]).toEqual([["doc-1", 1]]);
  expect(page.lexicalScores?.bestScoreById).toEqual(new Map([["doc-1", 80]]));
});

test.each([
  {
    scores: [-1],
    message: "BM25 ratio ranking requires a nonnegative top score",
  },
  { scores: [1, -1], message: "BM25 ratio ranking received an invalid score" },
  { scores: [1, 2], message: "BM25 ratio ranking received an invalid score" },
])(
  "BM25 ranking rejects invalid engine scores $scores",
  async ({ scores, message }) => {
    stubRankingScores(scores);
    await expect(
      readCorpusIndexSearchPage({
        ...rankingTestOptions,
        rankingMode: "bm25-ratio",
      }),
    ).rejects.toThrow(message);
  },
);

test("the experimental ranking defaults off and rejects unknown modes", () => {
  const schema = envBaseServerSchema.CORPUS_INDEX_RANKING_MODE;
  expect(v.parse(schema, undefined)).toBe("off");
  expect(v.parse(schema, "bm25-ratio")).toBe("bm25-ratio");
  expect(v.safeParse(schema, "typo").success).toBe(false);
});

test("ranking-mode changes invalidate cursor targets while off preserves them", () => {
  for (const target of [null, "a".repeat(32)]) {
    expect(corpusRankingCursorTarget(target, "off")).toBe(target);
    const candidate = corpusRankingCursorTarget(target, "bm25-ratio");
    expect(candidate).toMatch(/^[a-f0-9]{32}$/u);
    expect(candidate).not.toBe(target);
    expect(corpusRankingCursorTarget(target, "bm25-ratio")).toBe(candidate);
  }
});

test("BM25 ranking replays a bounded deduplicated universe with scale-invariant pages", async () => {
  let scale = 1;
  const requests: { from: number; size: number }[] = [];
  globalThis.fetch = Object.assign(
    async (
      _input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const body = JSON.parse(String(init?.body));
      requests.push({ from: body.from, size: body.size });
      const hits = Array.from({ length: 7100 }, (_, rank) => ({
        _source: {
          document_id: rank < 2 ? "first" : `doc-${rank}`,
          chunk_id: `passage-${rank}`,
          anchor_id: `anchor-${rank}`,
        },
        _score: (100 - rank / 100) * scale,
      }));
      return new Response(
        JSON.stringify({
          hits: {
            total: { value: hits.length },
            hits: hits.slice(body.from, body.from + body.size),
          },
        }),
      );
    },
    { preconnect: originalFetch.preconnect },
  );

  let hydratedIds: readonly string[] = [];
  let hydrationRounds = 0;
  const read = async (parsedCursor: SearchCursor | null = null) =>
    await readCorpusIndexSearchPage({
      observer: "unobserved",
      cluster: "q09",
      indexId: "case_law_v7_cs_sk",
      query: "text:fiction",
      order: RELEVANCE_ORDER,
      rankingMode: "bm25-ratio",
      scanTransport: { type: "scored", fields: ["document_id"] },
      limit: 10,
      parsedCursor,
      snippetFields: [],
      extractId: (hit) =>
        typeof hit["document_id"] === "string" ? hit["document_id"] : null,
      extractSnippet: () => null,
      // The old position bound would stop immediately; it cannot truncate
      // the experiment's fixed BM25 universe.
      unseenScoreUpperBound: () => 0,
      rankCandidates: async (candidates) => {
        hydrationRounds += 1;
        hydratedIds = candidates.map(({ id }) => id);
        const ranked = blendStableCitationAuthority({
          candidates,
          authorityById: new Map([["doc-6513", 100]]),
          signals: [courtTierSignal(new Map([["doc-6513", 4]]))],
        });
        return {
          context: null,
          ranked: collapseByLanguageGroup(ranked, (id) =>
            id === "doc-9" || id === "doc-10" ? "judgment" : null,
          ).representatives,
        };
      },
    });

  const first = await read();
  expect(first.pageRanked.at(0)?.id).toBe("doc-6513");
  expect(first.scan.passagesScanned).toBe(CORPUS_BM25_PASSAGE_LIMIT);
  expect(first.scan.rounds).toBe(1);
  expect(hydrationRounds).toBe(1);
  expect(first.scan.earlyStopped).toBe(false);
  expect(hydratedIds.length).toBe(6999);
  expect(new Set(hydratedIds).size).toBe(hydratedIds.length);
  expect(hydratedIds).not.toContain("doc-7000");
  expect(first.anchorIdById.get("first")).toBe("anchor-0");
  expect(first.nextCursor?.windowStart).toBe(0);
  expect(first.nextCursor?.id).toBe("doc-9");
  scale = 8;
  const scaled = await read();
  expect(scaled.pageRanked).toEqual(first.pageRanked);
  const second = await read(first.nextCursor);
  expect(second.pageRanked.length).toBe(10);
  expect(second.pageRanked.map(({ id }) => id)).not.toContain("doc-10");
  expect(
    second.pageRanked.some(({ id }) =>
      first.pageRanked.some((hit) => hit.id === id),
    ),
  ).toBe(false);
  expect(requests).toEqual(
    Array.from({ length: 3 }, () => ({
      from: 0,
      size: CORPUS_BM25_PASSAGE_LIMIT,
    })),
  );
  scale = 0;
  const filterOnly = await read();
  expect(
    filterOnly.pageRanked.every(({ lexicalScore }) => lexicalScore === 0),
  ).toBe(true);
});

test("BM25 ranking refuses a moving window or a transport without scores", async () => {
  const base = {
    observer: "unobserved",
    cluster: "q09",
    indexId: "case_law_v7_cs_sk",
    query: "text:fiction",
    order: RELEVANCE_ORDER,
    rankingMode: "bm25-ratio",
    limit: 10,
    parsedCursor: null,
    snippetFields: [],
    extractId: () => null,
    extractSnippet: () => null,
    unseenScoreUpperBound: stableBlendUpperBound,
    rankCandidates: async () => ({ context: null, ranked: [] }),
  } satisfies Parameters<typeof readCorpusIndexSearchPage>[0];
  await expect(readCorpusIndexSearchPage(base)).rejects.toThrow(
    "BM25 ranking requires",
  );
  await expect(
    readCorpusIndexSearchPage({
      ...base,
      scanTransport: { type: "scored", fields: ["document_id"] },
      parsedCursor: {
        score: 1,
        id: "old",
        windowStart: 900,
        sort: "relevance",
      },
    }),
  ).rejects.toThrow("BM25 ranking requires");
  await expect(
    readCorpusIndexSearchPage({
      ...base,
      scanTransport: { type: "scored", fields: ["document_id"] },
      order: { type: "newest", timestampField: "decision_date_ts" },
    }),
  ).rejects.toThrow("BM25 ranking requires");
});
