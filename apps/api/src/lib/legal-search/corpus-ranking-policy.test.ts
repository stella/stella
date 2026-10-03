import { panic, Result } from "better-result";
import { afterEach, expect, test } from "bun:test";
import fc from "fast-check";
import * as v from "valibot";

import { assertProperty } from "@stll/property-testing";

import { envBaseServerSchema } from "@/api/env-base-schema";
import {
  readCorpusIndexSearchPage,
  type SearchCursor,
} from "@/api/lib/legal-search/corpus-index-pagination";
import {
  CORPUS_BM25_PASSAGE_LIMIT,
  corpusRankingCursorTarget,
  corpusQueryRankingMode,
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
    groups: [],
    ranked: blendStableCitationAuthority({
      candidates,
      authorityById: new Map(),
    }),
  }),
} satisfies Parameters<typeof readCorpusIndexSearchPage>[0];

const stubRankingScores = (
  scores: readonly number[],
  passagesPerDocument = 1,
) => {
  globalThis.fetch = Object.assign(
    async (
      _input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const requestBody = init?.body;
      if (typeof requestBody !== "string") {
        throw new TypeError("Expected a JSON request body");
      }
      const body = JSON.parse(requestBody);
      const hits = scores.map((score, rank) => ({
        _source: {
          document_id: `doc-${Math.floor(rank / passagesPerDocument)}`,
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
  await assertProperty(
    "BM25 normalization preserves ordering and pages under positive score scaling",
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
  );
});

test("omitting the ranking flag preserves explicit OFF pages and cursors", async () => {
  await assertProperty(
    "omitting the ranking flag preserves explicit OFF pages and cursors",
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
    const result = await Result.tryPromise(async () =>
      readCorpusIndexSearchPage({
        ...rankingTestOptions,
        rankingMode: "bm25-ratio",
      }),
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.cause).toMatchObject({ message });
    }
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
      const requestBody = init?.body;
      if (typeof requestBody !== "string") {
        throw new TypeError("Expected a JSON request body");
      }
      const body = JSON.parse(requestBody);
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
        const { representatives, groupTokenById } = collapseByLanguageGroup(
          ranked,
          (id) => (id === "doc-9" || id === "doc-10" ? "judgment" : null),
        );
        return {
          context: null,
          ranked: representatives,
          groups: [...groupTokenById]
            .filter(([id]) => id === "doc-9" || id === "doc-10")
            .map(([, token]) => token),
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
      size: CORPUS_BM25_PASSAGE_LIMIT + 1,
    })),
  );
  scale = 0;
  const filterOnly = await read();
  expect(filterOnly.nextCursor?.rankingMode === "off").toBe(true);
});

test("BM25 pages honor and carry the groups their cursor excludes", async () => {
  stubRankingScores([100, 90, 80, 70, 60]);
  const groupKeyOf = (id: string) =>
    id === "doc-1" || id === "doc-3" ? "judgment" : null;
  const judgmentToken = collapseByLanguageGroup(
    [{ id: "doc-1" }],
    groupKeyOf,
  ).groupTokenById.get("doc-1");
  if (judgmentToken === undefined) {
    throw new Error("Expected a token for the grouped judgment");
  }
  const read = async (parsedCursor: SearchCursor | null) =>
    await readCorpusIndexSearchPage({
      ...rankingTestOptions,
      rankingMode: "bm25-ratio",
      limit: 1,
      parsedCursor,
      rankCandidates: async (candidates) => {
        const { representatives, groupTokenById } = collapseByLanguageGroup(
          blendStableCitationAuthority({
            candidates,
            authorityById: new Map(),
          }),
          groupKeyOf,
        );
        const excluded = new Set(parsedCursor?.excludedGroups);
        return {
          context: null,
          ranked: representatives.filter(
            ({ id }) =>
              !excluded.has(
                groupTokenById.get(id) ?? panic("Missing representative token"),
              ),
          ),
          groups: [...groupTokenById]
            .filter(([id]) => groupKeyOf(id) !== null)
            .map(([, token]) => token),
        };
      },
    });

  const first = await read(null);
  expect(first.pageRanked.map(({ id }) => id)).toEqual(["doc-0"]);
  expect(first.nextCursor?.excludedGroups).toBeUndefined();
  if (first.nextCursor === null) {
    throw new Error("Expected a continuation");
  }
  const second = await read({
    ...first.nextCursor,
    excludedGroups: [judgmentToken],
  });
  expect(second.pageRanked.map(({ id }) => id)).toEqual(["doc-2"]);
  expect(second.nextCursor?.rankingMode).toBe("bm25-ratio");
  expect(second.nextCursor?.excludedGroups).toEqual([judgmentToken]);
  const third = await read(second.nextCursor);
  expect(third.pageRanked.map(({ id }) => id)).toEqual(["doc-4"]);
  expect(third.nextCursor).toBeNull();
});

test("BM25 ranking refuses a transport without scores or a date order", async () => {
  for (const options of [
    { ...rankingTestOptions, scanTransport: undefined },
    {
      ...rankingTestOptions,
      order: { type: "newest", timestampField: "decision_date_ts" } as const,
    },
  ]) {
    const result = await Result.tryPromise(async () =>
      readCorpusIndexSearchPage({ ...options, rankingMode: "bm25-ratio" }),
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.cause).toMatchObject({
        message: expect.stringContaining("BM25 ranking requires"),
      });
    }
  }
});

test("client BM25 cursors require server eligibility and window zero", async () => {
  for (const rankingMode of ["off", "bm25-ratio"] as const) {
    for (const windowStart of [0, 900]) {
      if (rankingMode === "bm25-ratio" && windowStart === 0) {
        continue;
      }
      const result = await Result.tryPromise(async () =>
        readCorpusIndexSearchPage({
          ...rankingTestOptions,
          rankingMode,
          parsedCursor: {
            score: 1,
            id: "old",
            windowStart,
            rankingMode: "bm25-ratio",
            sort: "relevance",
          },
        }),
      );
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.cause).toMatchObject({
          status: 400,
          message: "Invalid cursor",
        });
      }
    }
  }
});

test("with ranking OFF no client cursor can enter the BM25 path", async () => {
  await assertProperty(
    "with ranking OFF no client cursor can enter the BM25 path",
    fc.asyncProperty(
      fc.option(fc.constantFrom("off", "bm25-ratio"), { nil: undefined }),
      fc.integer({ min: 0, max: 100 }),
      fc.double({ min: 0, max: 1, noNaN: true }),
      async (rankingMode, window, score) => {
        const sizes: number[] = [];
        globalThis.fetch = Object.assign(
          async (
            _input: Parameters<typeof fetch>[0],
            init?: Parameters<typeof fetch>[1],
          ) => {
            const body = init?.body;
            if (typeof body !== "string") {
              throw new TypeError("Expected a JSON request body");
            }
            sizes.push(JSON.parse(body).size);
            return new Response(
              JSON.stringify({ hits: { total: { value: 0 }, hits: [] } }),
            );
          },
          { preconnect: originalFetch.preconnect },
        );
        const result = await Result.tryPromise(async () =>
          readCorpusIndexSearchPage({
            ...rankingTestOptions,
            rankingMode: "off",
            parsedCursor: {
              score,
              id: "client-id",
              windowStart: window * 900,
              ...(rankingMode === undefined ? {} : { rankingMode }),
              sort: "relevance",
            },
          }),
        );
        expect(sizes).not.toContain(CORPUS_BM25_PASSAGE_LIMIT + 1);
        if (rankingMode === "bm25-ratio") {
          expect(sizes).toEqual([]);
          expect(result.isErr()).toBe(true);
          if (result.isErr()) {
            expect(result.error.cause).toMatchObject({
              status: 400,
              message: "Invalid cursor",
            });
          }
        } else {
          expect(result.isOk()).toBe(true);
        }
      },
    ),
  );
});

test("ties below the cutoff page deterministically despite engine tie order", async () => {
  await assertProperty(
    "ties below the cutoff page deterministically despite engine tie order",
    fc.asyncProperty(
      fc.integer({ min: 2, max: 40 }),
      fc.integer({ min: 1, max: 9 }),
      async (count, limit) => {
        let request = 0;
        globalThis.fetch = Object.assign(
          async () => {
            request += 1;
            const hits = Array.from({ length: count }, (_, index) =>
              ["p0", "p1"].map((anchor_id) => ({
                _source: {
                  document_id: `doc-${String(index).padStart(3, "0")}`,
                  anchor_id,
                },
                _score: 1,
              })),
            ).flat();
            if (request % 2 === 0) {
              hits.reverse();
            }
            return new Response(
              JSON.stringify({ hits: { total: { value: hits.length }, hits } }),
            );
          },
          { preconnect: originalFetch.preconnect },
        );
        const seen: string[] = [];
        let cursor: SearchCursor | null = null;
        for (let page = 0; page < Math.ceil(count / limit); page += 1) {
          // An explicit result type breaks the cursor/result inference cycle.
          const result: Awaited<ReturnType<typeof readCorpusIndexSearchPage>> =
            await readCorpusIndexSearchPage({
              ...rankingTestOptions,
              limit,
              rankingMode: "bm25-ratio",
              parsedCursor: cursor,
            });
          seen.push(...result.pageRanked.map(({ id }) => id));
          for (const { id } of result.pageRanked) {
            expect(result.anchorIdById.get(id)).toBe("p0");
          }
          cursor = result.nextCursor;
          if (cursor !== null) {
            expect(cursor.rankingMode).toBe("bm25-ratio");
          }
        }
        expect(cursor).toBeNull();
        expect(new Set(seen)).toEqual(
          new Set(
            Array.from(
              { length: count },
              (_, index) => `doc-${String(index).padStart(3, "0")}`,
            ),
          ),
        );
        expect(seen).toHaveLength(count);
        expect(new Set(seen).size).toBe(count);
      },
    ),
  );
});

test("a tied cutoff falls back once and every position page keeps that mode", async () => {
  await assertProperty(
    "a tied cutoff falls back once and every position page keeps that mode",
    fc.asyncProperty(
      fc.integer({ min: 1, max: 20 }),
      fc.integer({ min: 100, max: 200 }),
      async (extra, limit) => {
        const count = CORPUS_BM25_PASSAGE_LIMIT + extra;
        stubRankingScores(Array.from({ length: count }, () => 1));
        let cursor: SearchCursor | null = null;
        const seen: string[] = [];
        for (
          let page = 0;
          page < Math.ceil(count / limit) + Math.ceil(count / 900) + 1;
          page += 1
        ) {
          // An explicit result type breaks the cursor/result inference cycle.
          const result: Awaited<ReturnType<typeof readCorpusIndexSearchPage>> =
            await readCorpusIndexSearchPage({
              ...rankingTestOptions,
              limit,
              rankingMode: "bm25-ratio",
              parsedCursor: cursor,
            });
          seen.push(...result.pageRanked.map(({ id }) => id));
          cursor = result.nextCursor;
          if (cursor === null) {
            break;
          }
          expect(cursor.rankingMode).toBe("off");
        }
        expect(cursor).toBeNull();
        expect(seen).toHaveLength(count);
        expect(new Set(seen).size).toBe(count);
      },
    ),
    { numRuns: 3 },
  );
});

test("filter-only and date queries always use position ranking", () => {
  assertProperty(
    "filter-only and date queries always use position ranking",
    fc.property(
      fc.constantFrom("off", "bm25-ratio"),
      fc.constantFrom("relevance", "newest"),
      fc.integer({ min: 0, max: 100 }),
      (configuredMode, sort, textTokenCount) => {
        expect(
          corpusQueryRankingMode({ configuredMode, sort, textTokenCount }),
        ).toBe(
          sort === "relevance" && textTokenCount > 0 ? configuredMode : "off",
        );
      },
    ),
  );
});
