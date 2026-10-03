import { Result } from "better-result";
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
  CORPUS_AUTHORITY_LEXICAL_RANK_DECAY,
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

test("authority mode reranks scored candidates without requesting an unmapped engine field", async () => {
  const lexical = [{ document_id: "lexical" }, { document_id: "cited" }];
  setEngine({
    lexical,
    authority: [{ document_id: "outside", citation_authority: 100 }],
  });
  const page = await runPage({
    authorityById: new Map([
      ["cited", 10],
      ["outside", 100],
    ]),
  });
  expect(page.pageRanked.at(0)?.id).toBe("cited");
  expect(page.context.ids).toEqual(["lexical", "cited"]);
  expect(page.scan.rounds).toBe(1);
  expect(requests.filter(({ type }) => type === "scored")).toHaveLength(1);
  expect(
    requests.every(({ body }) => body["sort_by"] !== "citation_authority"),
  ).toBe(true);
  const second = await runPage({
    authorityById: new Map([["cited", 10]]),
    limit: 1,
  });
  const next = await runPage({
    authorityById: new Map([["cited", 10]]),
    parsedCursor: second.nextCursor,
  });
  expect(next.pageRanked.map(({ id }) => id)).toEqual(["lexical"]);
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
          authority.map((hit) => [hit.document_id, hit.citation_authority]),
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
  const result = await Result.tryPromise(async () =>
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
  );
  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.cause).toBeInstanceOf(HandlerError);
  }
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
