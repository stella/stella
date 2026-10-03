import { afterEach, beforeEach, expect, test } from "bun:test";
import fc from "fast-check";
import * as v from "valibot";

import { assertProperty } from "@stll/property-testing";

import { envBaseServerSchema } from "@/api/env-base-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { CorpusIndexHit } from "@/api/lib/legal-search/corpus-index-client";
import {
  readCorpusIndexSearchPage,
  type SearchCursor,
} from "@/api/lib/legal-search/corpus-index-pagination";
import {
  corpusQueryRankingMode,
  corpusRankingCursorTarget,
  CORPUS_INDEX_RANKING_MODES,
  CORPUS_AUTHORITY_EXTRA_ENGINE_CALLS,
  CORPUS_AUTHORITY_LEXICAL_RANK_DECAY,
  CORPUS_AUTHORITY_PASSAGE_LIMIT,
  CORPUS_BM25_PASSAGE_LIMIT,
} from "@/api/lib/legal-search/corpus-ranking-policy";
import { RELEVANCE_ORDER } from "@/api/lib/legal-search/corpus-search-order";
import { collapseByLanguageGroup } from "@/api/lib/legal-search/language-group-collapse";
import {
  blendStableCitationAuthority,
  CORPUS_EXPERIMENTAL_AUTHORITY_WEIGHT,
} from "@/api/lib/legal-search/rerank";
import { isRecord } from "@/api/lib/type-guards";

type SearchHit = {
  document_id: string;
  citation_authority?: number;
  jurisdiction?: string;
  text?: string;
  chunk_id?: string;
  anchor_id?: string;
};

type SetEngineOptions = {
  lexical: SearchHit[];
  authority?: SearchHit[];
};

type RunPageOptions = {
  authorityById: ReadonlyMap<string, number>;
  parsedCursor?: SearchCursor | null;
  limit?: number;
};

type RecordedRequest = {
  body: Record<string, unknown>;
  type: "scored" | "native";
};

const originalFetch = globalThis.fetch;
let engineLexicalHits: SearchHit[];
let engineAuthorityHits: SearchHit[];
let requests: RecordedRequest[];

const setEngine = ({ lexical, authority = lexical }: SetEngineOptions) => {
  engineLexicalHits = lexical;
  engineAuthorityHits = authority;
};

const queryTextOf = (body: Record<string, unknown>): string | null => {
  const queryValue = body["query"];
  if (typeof queryValue === "string") {
    return queryValue;
  }
  if (!isRecord(queryValue) || !isRecord(queryValue["query_string"])) {
    return null;
  }
  const query = queryValue["query_string"]["query"];
  return typeof query === "string" ? query : null;
};

const hitsMatchingQuery = (
  body: Record<string, unknown>,
  hits: SearchHit[],
): SearchHit[] => {
  const queryText = queryTextOf(body);
  const jurisdiction = queryText?.match(/(?:^|\s)jurisdiction:([^\s]+)/u)?.[1];
  const requiresEmployment = queryText?.match(
    /(?:^|\s)text:employment(?:\s|$)/u,
  );
  return hits.filter(
    (hit) =>
      (hit.jurisdiction === undefined ||
        jurisdiction === undefined ||
        hit.jurisdiction === jurisdiction) &&
      (hit.text === undefined ||
        requiresEmployment === undefined ||
        hit.text.toLowerCase().includes("employment")),
  );
};

beforeEach(() => {
  requests = [];
  setEngine({ lexical: [] });
  const stub = async (
    _input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const body: Record<string, unknown> =
      typeof init?.body === "string" ? JSON.parse(init.body) : {};
    const isScored = typeof body["from"] === "number";
    requests.push({ body, type: isScored ? "scored" : "native" });
    if (isScored) {
      const from = Number(body["from"]);
      const size = Number(body["size"]);
      const matchingHits = hitsMatchingQuery(body, engineLexicalHits);
      const hits = matchingHits.slice(from, from + size).map((hit, rank) => ({
        _source: {
          ...hit,
          chunk_id: hit.chunk_id ?? `lexical-${from + rank}`,
        },
        _score: 10_000 - from - rank,
      }));
      return new Response(
        JSON.stringify({
          hits: { total: { value: matchingHits.length }, hits },
        }),
      );
    }

    const isAuthorityRead = body["sort_by"] === "citation_authority";
    const sourceHits = hitsMatchingQuery(
      body,
      isAuthorityRead ? engineAuthorityHits : engineLexicalHits,
    ).toSorted((left, right) =>
      isAuthorityRead
        ? (right.citation_authority ?? 0) - (left.citation_authority ?? 0)
        : 0,
    );
    const offset = Number(body["start_offset"] ?? 0);
    const size = Number(body["max_hits"] ?? sourceHits.length);
    const hits = sourceHits.slice(offset, offset + size);
    const response: Record<string, unknown> = {
      num_hits: sourceHits.length,
      hits,
    };
    if (body["snippet_fields"] !== undefined) {
      response["snippets"] = hits.map((hit) => ({
        text: [`snippet ${hit.document_id}`],
      }));
    }
    return new Response(JSON.stringify(response));
  };
  globalThis.fetch = Object.assign(stub, {
    preconnect: originalFetch.preconnect,
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const query = "text:employment AND jurisdiction:cz";
const runPage = async ({
  authorityById,
  parsedCursor = null,
  limit = 10,
}: RunPageOptions) =>
  await readCorpusIndexSearchPage({
    observer: "unobserved",
    cluster: "q09",
    indexId: "case_law_v7_cs_sk",
    query,
    order: RELEVANCE_ORDER,
    rankingMode: "authority-rank",
    scanTransport: { type: "scored", fields: ["document_id"] },
    limit,
    parsedCursor,
    snippetFields: ["text"],
    extractId: (hit: CorpusIndexHit) =>
      typeof hit["document_id"] === "string" ? hit["document_id"] : null,
    extractSnippet: (snippet) => {
      const text = snippet?.["text"];
      return Array.isArray(text) ? String(text.at(0)) : null;
    },
    unseenScoreUpperBound: (score) =>
      score + CORPUS_EXPERIMENTAL_AUTHORITY_WEIGHT,
    rankCandidates: async (candidates, effectiveRankingMode) => ({
      context: {
        ids: candidates.map(({ id }) => id),
        rankingMode: effectiveRankingMode,
      },
      ranked: blendStableCitationAuthority({
        candidates,
        authorityById,
        rankingMode: effectiveRankingMode,
      }),
    }),
  });

const runOffPage = async (hits: SearchHit[], rankingMode?: "off") => {
  setEngine({ lexical: hits });
  return await readCorpusIndexSearchPage({
    observer: "unobserved",
    cluster: "q09",
    indexId: "case_law_v7_cs_sk",
    query,
    order: RELEVANCE_ORDER,
    ...(rankingMode === undefined ? {} : { rankingMode }),
    limit: 10,
    parsedCursor: null,
    snippetFields: [],
    extractId: (hit: CorpusIndexHit) =>
      typeof hit["document_id"] === "string" ? hit["document_id"] : null,
    extractSnippet: () => null,
    unseenScoreUpperBound: (score) => score,
    rankCandidates: async (candidates, effectiveRankingMode) => ({
      context: { mode: effectiveRankingMode },
      ranked: blendStableCitationAuthority({
        candidates,
        authorityById: new Map(),
        rankingMode: effectiveRankingMode,
      }),
    }),
  });
};

const compactPage = (page: Awaited<ReturnType<typeof runOffPage>>) => ({
  pageRanked: page.pageRanked,
  nextCursor: page.nextCursor,
  anchorIdById: [...page.anchorIdById],
  passageCountById: [...page.passageCountById],
  snippetById: [...page.snippetById],
  context: page.context,
  scan: { ...page.scan, indexMs: 0 },
});

test("authority reads share the full query and keep only complete positive cutoff tiers", async () => {
  const lexical: SearchHit[] = [{ document_id: "lexical", anchor_id: "lex-a" }];
  const authority = Array.from(
    { length: CORPUS_AUTHORITY_PASSAGE_LIMIT + 1 },
    (_, index) => ({
      document_id: `authority-${String(index).padStart(3, "0")}`,
      citation_authority:
        index < CORPUS_AUTHORITY_PASSAGE_LIMIT - 2 ? 10_000 - index : 1,
      chunk_id: `clause-${String(index).padStart(3, "0")}`,
      anchor_id: `anchor-${index}`,
    }),
  );
  // The last three records form the tier straddling the limit/lookahead seam.
  setEngine({ lexical, authority });
  const seenCandidates: string[][] = [];
  const page = await readCorpusIndexSearchPage({
    observer: "unobserved",
    cluster: "q09",
    indexId: "case_law_v7_cs_sk",
    query,
    order: RELEVANCE_ORDER,
    rankingMode: "authority-rank",
    scanTransport: { type: "scored", fields: ["document_id"] },
    limit: CORPUS_AUTHORITY_PASSAGE_LIMIT + 1,
    parsedCursor: null,
    snippetFields: [],
    extractId: (hit) =>
      typeof hit["document_id"] === "string" ? hit["document_id"] : null,
    extractSnippet: () => null,
    unseenScoreUpperBound: (score) => score,
    rankCandidates: async (candidates, effectiveRankingMode) => {
      seenCandidates.push(candidates.map(({ id }) => id));
      return {
        context: effectiveRankingMode,
        ranked: blendStableCitationAuthority({
          candidates,
          authorityById: new Map(
            authority.map((hit) => [
              hit.document_id,
              hit.citation_authority ?? 0,
            ]),
          ),
          rankingMode: effectiveRankingMode,
        }),
      };
    },
  });

  const scored = requests.find((request) => request.type === "scored");
  const lane = requests.find(
    (request) => request.body["sort_by"] !== undefined,
  );
  expect(scored?.body).toMatchObject({
    query: { query_string: { query } },
    from: 0,
    size: CORPUS_BM25_PASSAGE_LIMIT + 1,
  });
  expect(lane?.body).toMatchObject({
    query,
    max_hits: CORPUS_AUTHORITY_PASSAGE_LIMIT + 1,
    sort_by: "citation_authority",
  });
  expect(seenCandidates).toHaveLength(1);
  expect(page.context).toBe("authority-rank");
  expect(seenCandidates.at(0)).not.toContain("authority-254");
  expect(seenCandidates.at(0)).not.toContain("authority-255");
  expect(seenCandidates.at(0)).not.toContain("authority-256");
});

test("permuting the cutoff tie does not change the admitted authority universe", async () => {
  const cutoffTies = [
    {
      document_id: "cutoff-tie-0",
      citation_authority: 1,
      chunk_id: "tie-clause-0",
    },
    {
      document_id: "cutoff-tie-1",
      citation_authority: 1,
      chunk_id: "tie-clause-1",
    },
    {
      document_id: "cutoff-tie-2",
      citation_authority: 1,
      chunk_id: "tie-clause-2",
    },
  ] as const;
  const authority = [
    ...Array.from(
      { length: CORPUS_AUTHORITY_PASSAGE_LIMIT - 2 },
      (_, index) => ({
        document_id: `authority-${String(index).padStart(3, "0")}`,
        citation_authority: 10_000 - index,
        chunk_id: `clause-${String(index).padStart(3, "0")}`,
      }),
    ),
    ...cutoffTies,
  ];
  const authorityById = new Map(
    authority.map((hit) => [hit.document_id, hit.citation_authority]),
  );
  setEngine({ lexical: [], authority });
  const first = await runPage({
    authorityById,
    limit: CORPUS_AUTHORITY_PASSAGE_LIMIT + 1,
  });
  setEngine({
    lexical: [],
    authority: [
      ...authority.slice(0, authority.length - cutoffTies.length),
      cutoffTies[2],
      cutoffTies[0],
      cutoffTies[1],
    ],
  });
  const shuffled = await runPage({
    authorityById,
    limit: CORPUS_AUTHORITY_PASSAGE_LIMIT + 1,
  });
  expect(first.context.ids).toHaveLength(CORPUS_AUTHORITY_PASSAGE_LIMIT - 2);
  expect(shuffled.context.ids).toEqual(first.context.ids);
  expect(shuffled.pageRanked).toEqual(first.pageRanked);
});

test("a lane-only deep match can lead the bounded result and pages replay the same universe", async () => {
  const lexicalHits = Array.from(
    { length: CORPUS_BM25_PASSAGE_LIMIT + 1 },
    (_, index) => ({
      document_id: `lexical-${index}`,
      chunk_id: `lexical-clause-${index}`,
      anchor_id: `lexical-anchor-${index}`,
      citation_authority: 0,
      text: "Short synthetic employment passage.",
    }),
  );
  const authorityHits = [
    {
      document_id: "deep-small-anchor",
      citation_authority: 4,
      chunk_id: "deep-small-clause",
      anchor_id: "deep-small-anchor-id",
      text: "A short synthetic passage about an employment agreement.",
    },
    {
      document_id: "deep-long-anchor",
      citation_authority: 3,
      chunk_id: "deep-long-clause",
      anchor_id: "deep-long-anchor-id",
      text: "A synthetic full employment match in a long passage. ".repeat(20),
    },
    {
      document_id: "lexical-0",
      citation_authority: 2,
      chunk_id: "duplicate-lexical-clause",
      anchor_id: "duplicate-lexical-anchor",
    },
    {
      document_id: "wrong-jurisdiction-high-authority",
      citation_authority: 10_000,
      chunk_id: "nonmatching-clause",
      jurisdiction: "de",
      text: "Employment phrase in another jurisdiction.",
    },
    {
      document_id: "wrong-text-high-authority",
      citation_authority: 9000,
      chunk_id: "unrelated-clause",
      jurisdiction: "cz",
      text: "This synthetic passage concerns civil procedure only.",
    },
  ];
  setEngine({ lexical: lexicalHits, authority: authorityHits });
  const authorityById = new Map(
    authorityHits.map((hit) => [hit.document_id, hit.citation_authority]),
  );

  const first = await runPage({ authorityById });
  expect(first.pageRanked.slice(0, 10).map(({ id }) => id)).toContain(
    "deep-small-anchor",
  );
  expect(first.pageRanked.slice(0, 10).map(({ id }) => id)).toContain(
    "deep-long-anchor",
  );
  expect(first.context.ids).not.toContain("wrong-jurisdiction-high-authority");
  expect(first.context.ids).not.toContain("wrong-text-high-authority");
  expect(first.context.ids.filter((id) => id === "lexical-0")).toHaveLength(1);
  expect(new Set(first.context.ids).size).toBe(first.context.ids.length);
  expect(
    first.pageRanked.find(({ id }) => id === "deep-small-anchor")?.lexicalScore,
  ).toBe(0);
  expect(
    first.pageRanked.find(({ id }) => id === "deep-long-anchor")?.lexicalScore,
  ).toBe(0);
  expect(first.anchorIdById.get("deep-small-anchor")).toBe(
    "deep-small-anchor-id",
  );
  expect(first.anchorIdById.get("deep-long-anchor")).toBe(
    "deep-long-anchor-id",
  );
  expect(first.scan.passagesScanned).toBe(
    CORPUS_BM25_PASSAGE_LIMIT + authorityHits.length - 2,
  );
  expect(first.scan.rounds).toBe(2);
  expect(requests.filter(({ type }) => type === "scored")).toHaveLength(1);
  expect(
    requests.filter(({ body }) => body["sort_by"] === "citation_authority"),
  ).toHaveLength(1);
  expect(requests).toHaveLength(
    1 + CORPUS_AUTHORITY_EXTRA_ENGINE_CALLS + first.scan.highlightRounds,
  );
  expect(requests.find(({ type }) => type === "scored")?.body).toMatchObject({
    query: { query_string: { query } },
  });
  expect(
    requests.find(({ body }) => body["sort_by"] === "citation_authority")?.body[
      "query"
    ],
  ).toBe(query);

  const second = await runPage({
    authorityById,
    parsedCursor: first.nextCursor,
  });
  expect(second.pageRanked.map(({ id }) => id)).not.toContain(
    "deep-small-anchor",
  );
  expect(second.pageRanked.map(({ id }) => id)).not.toContain(
    "deep-long-anchor",
  );
  expect(second.nextCursor?.windowStart).toBe(0);
  expect(second.context.ids).toEqual(first.context.ids);
  expect(second.context.rankingMode).toBe("authority-rank");
  expect(requests.filter(({ type }) => type === "scored")).toHaveLength(2);
  expect(
    requests.filter(({ body }) => body["sort_by"] === "citation_authority"),
  ).toHaveLength(2);

  const off = await runOffPage(lexicalHits);
  expect(off.pageRanked.map(({ id }) => id)).not.toContain("deep-small-anchor");
  expect(compactPage(off)).toEqual(
    compactPage(await runOffPage(lexicalHits, "off")),
  );
});

test("OFF keeps its serialized page contract", async () => {
  const page = await runOffPage([
    { document_id: "doc-a" },
    { document_id: "doc-b" },
  ]);
  const expected = {
    pageRanked: [
      { id: "doc-a", score: 1, lexicalScore: 1, citationAuthority: 0 },
      {
        id: "doc-b",
        score: 0.9966722160545233,
        lexicalScore: 0.9966722160545233,
        citationAuthority: 0,
      },
    ],
    nextCursor: null,
    anchorIdById: [],
    passageCountById: [
      ["doc-a", 1],
      ["doc-b", 1],
    ],
    snippetById: [],
    context: { mode: "off" },
    scan: {
      rounds: 1,
      passagesScanned: 2,
      indexMs: 0,
      earlyStopped: false,
      roundCapHit: false,
      highlightRounds: 0,
    },
  };
  expect(JSON.stringify(compactPage(page))).toBe(JSON.stringify(expected));
});

test("language representatives remain unique across pages of the admitted universe", async () => {
  await assertProperty(
    "language representatives remain unique across pages of the admitted universe",
    fc.asyncProperty(
      fc.record({
        groupCount: fc.integer({ min: 2, max: 8 }),
        lexicalCopies: fc.integer({ min: 1, max: 3 }),
        lexicalPassages: fc.integer({ min: 1, max: 3 }),
        authorityCopies: fc.integer({ min: 0, max: 3 }),
        authorityPassages: fc.integer({ min: 1, max: 3 }),
        siblingStrength: fc.integer({ min: 1, max: 30 }),
        equalAuthority: fc.boolean(),
        permuteLaneTies: fc.boolean(),
        pageSize: fc.integer({ min: 1, max: 5 }),
      }),
      async ({
        groupCount,
        lexicalCopies,
        lexicalPassages,
        authorityCopies,
        authorityPassages,
        siblingStrength,
        equalAuthority,
        permuteLaneTies,
        pageSize,
      }) => {
        const lexical = Array.from(
          { length: groupCount },
          (_groupValue, group) =>
            Array.from({ length: lexicalCopies }, (_languageValue, language) =>
              Array.from(
                { length: lexicalPassages },
                (_passageValue, passage) => ({
                  document_id: `case-${group}-l${language}`,
                  chunk_id: `lex-${group}-${language}-${passage}`,
                  anchor_id: `lex-anchor-${group}-${language}-${passage}`,
                }),
              ),
            ).flat(),
        ).flat();
        const authority = Array.from(
          { length: groupCount },
          (_groupValue, group) =>
            Array.from({ length: authorityCopies }, (_copyValue, copy) => {
              const language =
                copy < lexicalCopies
                  ? copy
                  : lexicalCopies + copy - lexicalCopies;
              const citationAuthority = equalAuthority
                ? 100
                : 20 + group * siblingStrength + copy;
              return Array.from(
                { length: authorityPassages },
                (_passageValue, passage) => ({
                  document_id: `case-${group}-l${language}`,
                  citation_authority: citationAuthority,
                  chunk_id: `auth-${group}-${language}-${passage}`,
                  anchor_id: `auth-anchor-${group}-${language}-${passage}`,
                }),
              );
            }).flat(),
        ).flat();
        const orderedAuthority =
          equalAuthority && permuteLaneTies
            ? authority.toReversed()
            : authority;
        const authorityById = new Map(
          authority.map((hit) => [
            hit.document_id,
            hit.citation_authority ?? 0,
          ]),
        );
        setEngine({ lexical, authority: orderedAuthority });
        const read = async (cursor: SearchCursor | null) =>
          await readCorpusIndexSearchPage({
            observer: "unobserved",
            cluster: "q09",
            indexId: "case_law_v7_cs_sk",
            query,
            order: RELEVANCE_ORDER,
            rankingMode: "authority-rank",
            scanTransport: { type: "scored", fields: ["document_id"] },
            limit: pageSize,
            parsedCursor: cursor,
            snippetFields: [],
            extractId: (hit) =>
              typeof hit["document_id"] === "string"
                ? hit["document_id"]
                : null,
            extractSnippet: () => null,
            unseenScoreUpperBound: (score) => score,
            rankCandidates: async (candidates, effectiveRankingMode) => {
              const ranked = blendStableCitationAuthority({
                candidates,
                authorityById,
                rankingMode: effectiveRankingMode,
              });
              const collapsed = collapseByLanguageGroup(ranked, (id) => {
                const match = /^case-(\d+)-l\d+$/u.exec(id);
                return match?.[1] ?? null;
              });
              return {
                context: {
                  allCandidateIds: candidates.map(({ id }) => id),
                  representatives: collapsed.representatives.map(
                    ({ id }) => id,
                  ),
                  foldedInto: [...collapsed.foldedInto],
                },
                ranked: collapsed.representatives,
                groups: [
                  ...new Set(
                    candidates.flatMap(({ id }) => {
                      const group = /^case-(\d+)-l\d+$/u.exec(id)?.[1];
                      return group === undefined ? [] : [group];
                    }),
                  ),
                ],
              };
            },
          });
        const first = await read(null);
        const expectedRepresentatives = first.context.representatives;
        const allCandidates = first.context.allCandidateIds;
        const emitted = first.pageRanked.map(({ id }) => id);
        let cursor = first.nextCursor;
        for (
          let pageIndex = 0;
          cursor !== null && pageIndex <= expectedRepresentatives.length;
          pageIndex += 1
        ) {
          const page = await read(cursor);
          emitted.push(...page.pageRanked.map(({ id }) => id));
          cursor = page.nextCursor;
        }
        expect(new Set(allCandidates).size).toBe(allCandidates.length);
        expect(emitted).toEqual(expectedRepresentatives);
        expect(new Set(emitted).size).toBe(emitted.length);
        const groupIds = emitted.map(
          (id) => /^case-(\d+)-l\d+$/u.exec(id)?.[1],
        );
        expect(new Set(groupIds).size).toBe(groupCount);
      },
    ),
  );
});

test("authority cursors reject a different ranking mode", async () => {
  setEngine({
    lexical: [{ document_id: "doc" }, { document_id: "other" }],
    authority: [{ document_id: "doc", citation_authority: 10 }],
  });
  const first = await runPage({
    authorityById: new Map([["doc", 10]]),
    limit: 1,
  });
  expect(first.nextCursor).not.toBeNull();
  if (first.nextCursor === null) {
    throw new Error("a one-hit page of two candidates must have a cursor");
  }
  await expect(
    readCorpusIndexSearchPage({
      observer: "unobserved",
      cluster: "q09",
      indexId: "case_law_v7_cs_sk",
      query,
      order: RELEVANCE_ORDER,
      rankingMode: "bm25-ratio",
      scanTransport: { type: "scored", fields: ["document_id"] },
      limit: 1,
      parsedCursor: first.nextCursor,
      snippetFields: [],
      extractId: (hit) =>
        typeof hit["document_id"] === "string" ? hit["document_id"] : null,
      extractSnippet: () => null,
      unseenScoreUpperBound: (score) => score,
      rankCandidates: async (candidates, effectiveRankingMode) => ({
        context: effectiveRankingMode,
        ranked: blendStableCitationAuthority({
          candidates,
          authorityById: new Map([["doc", 10]]),
          rankingMode: effectiveRankingMode,
        }),
      }),
    }),
  ).rejects.toBeInstanceOf(HandlerError);
});

test("authority mode has an explicit schema, eligibility, and cursor target", () => {
  const schema = envBaseServerSchema.CORPUS_INDEX_RANKING_MODE;
  expect(v.parse(schema, "authority-rank")).toBe("authority-rank");
  expect(CORPUS_INDEX_RANKING_MODES).toContain("authority-rank");
  expect(
    corpusQueryRankingMode({
      configuredMode: "authority-rank",
      sort: "relevance",
      textTokenCount: 1,
    }),
  ).toBe("authority-rank");
  expect(
    corpusQueryRankingMode({
      configuredMode: "authority-rank",
      sort: "newest",
      textTokenCount: 1,
    }),
  ).toBe("off");
  const target = "a".repeat(32);
  expect(corpusRankingCursorTarget(target, "authority-rank")).not.toBe(
    corpusRankingCursorTarget(target, "bm25-ratio"),
  );
});

test("authority mode assigns lexical candidates their global rank decay", async () => {
  const lexical = Array.from({ length: 3 }, (_, index) => ({
    document_id: `doc-${index}`,
  }));
  setEngine({ lexical, authority: [] });
  const page = await runPage({ authorityById: new Map(), limit: 3 });
  expect(
    page.pageRanked.map(({ id, lexicalScore }) => [id, lexicalScore]),
  ).toEqual(
    lexical.map((hit, index) => [
      hit.document_id,
      Math.exp(-index / CORPUS_AUTHORITY_LEXICAL_RANK_DECAY),
    ]),
  );
});

test("zero authority does not admit a lane-only candidate", async () => {
  setEngine({
    lexical: [],
    authority: [
      { document_id: "positive", citation_authority: 10 },
      { document_id: "zero", citation_authority: 0 },
    ],
  });
  const page = await runPage({
    authorityById: new Map([
      ["positive", 10],
      ["zero", 0],
    ]),
    limit: 5,
  });
  expect(page.pageRanked.map(({ id }) => id)).toEqual(["positive"]);
});

test.each([
  { document_id: "missing" },
  { document_id: "negative", citation_authority: -1 },
  { document_id: "nonfinite", citation_authority: Number.NaN },
])(
  "an invalid authority lane value is surfaced as an upstream error",
  async (hit) => {
    setEngine({ lexical: [], authority: [hit] });
    await expect(runPage({ authorityById: new Map() })).rejects.toMatchObject({
      status: 502,
      message: "Search is temporarily unavailable",
    });
  },
);
