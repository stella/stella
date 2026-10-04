import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { ElysiaCustomStatusResponse } from "elysia/error";

import { envBase } from "@/api/env-base";
import {
  searchCorpusIndexDecisions,
  searchDecisionsHandler,
} from "@/api/handlers/case-law/decisions/search";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { bodyPreviewJoin } from "@/api/lib/case-law/search-sql";
import { corpusIndexReadTarget } from "@/api/lib/legal-search/corpus-index-group-contract";
import type { ServingCorpusIndexTarget } from "@/api/lib/legal-search/corpus-index-group-enrollment-store";
import { CORPUS_INDEX_MANIFESTS } from "@/api/lib/legal-search/corpus-index-manifest";
import {
  CORPUS_INDEX_QUERY_VARIANTS,
  corpusQueryVariantCursorTarget,
} from "@/api/lib/legal-search/corpus-query-variant-policy";
import { corpusRankingCursorTarget } from "@/api/lib/legal-search/corpus-ranking-policy";
import { encodeCorpusSearchCursor } from "@/api/lib/legal-search/corpus-search-cursor";
import { NO_EXPANSION_DICTIONARY_IDENTITY } from "@/api/lib/legal-search/morphology/dictionary";

describe("case-law search body preview SQL", () => {
  test("does not expand non-array sections JSONB values", () => {
    const dialect = new PgDialect();
    const compiled = dialect.sqlToQuery(bodyPreviewJoin);

    expect(compiled.sql).toContain("CASE jsonb_typeof(d.sections)");
    expect(compiled.sql).toContain("WHEN 'array' THEN d.sections");
    expect(compiled.sql).toContain("ELSE '[]'::jsonb");
  });
});

describe("PostgreSQL metadata filter admission", () => {
  const unreadableDb = Object.assign(
    async () => panic("Rejected metadata filters must not read the database"),
    caseLawPublicReadDb,
  );

  test.each([
    { category: "A" },
    { hasLegalSentence: true },
    { hasLegalSentence: false },
    { category: "B", hasLegalSentence: false },
  ])("refuses unindexed filters before querying (%j)", async (filters) => {
    const result = await searchDecisionsHandler({
      body: { query: "náhrada škody", country: "CZE", ...filters },
      caseLawDb: unreadableDb,
      observer: "unobserved",
    });
    expect(result).toBeInstanceOf(ElysiaCustomStatusResponse);
    if (!(result instanceof ElysiaCustomStatusResponse)) {
      panic("Expected metadata-filter rejection");
    }
    expect(result.code).toBe(400);
    expect(result.response.message).toContain("require corpus-index search");
    expect(result.response.message).toContain(
      "Remove category and hasLegalSentence",
    );
  });
});

test("the corpus handler rejects a cursor after a query variant changes", async () => {
  const manifest = CORPUS_INDEX_MANIFESTS.case_law_v7;
  const resolution = corpusIndexReadTarget({
    manifest,
    jurisdiction: "SVK",
    attestedGroups: new Set(),
    enrolledGroups: new Set(),
  });
  if (resolution.type !== "ready") {
    panic("Expected the base Slovak corpus group to be ready");
  }
  const target = {
    ...resolution.target,
    manifest,
    serving: {
      family: "case_law",
      generation: manifest.generation,
      cluster: manifest.cluster,
    },
  } as const satisfies ServingCorpusIndexTarget;
  const unreadableDb = Object.assign(
    async () =>
      panic("A cursor for another variant must not read rows or court weights"),
    caseLawPublicReadDb,
  );
  for (const mintedVariant of CORPUS_INDEX_QUERY_VARIANTS) {
    const cursor = encodeCorpusSearchCursor({
      dictionary: NO_EXPANSION_DICTIONARY_IDENTITY,
      id: "5a3e6f52-1f0b-4f7e-9a44-3f2c1d0e9b8a",
      score: 0.5,
      sort: "relevance",
      windowStart: 0,
      target: corpusQueryVariantCursorTarget(
        corpusRankingCursorTarget(
          target.cursorTarget,
          envBase.CORPUS_INDEX_RANKING_MODE,
        ),
        mintedVariant,
      ),
    });
    const result = await searchCorpusIndexDecisions({
      body: { query: "§ 451 Občianskeho zákonníka", country: "SVK", cursor },
      caseLawDb: unreadableDb,
      observer: "unobserved",
      dependencies: {
        configuredVariant: mintedVariant === "off" ? "provision-refs" : "off",
        readServingTarget: async () => Result.ok(target),
      },
    });
    expect(result).toBeInstanceOf(ElysiaCustomStatusResponse);
    if (!(result instanceof ElysiaCustomStatusResponse)) {
      panic("Expected cross-variant cursor rejection");
    }
    expect(result.code).toBe(400);
    expect(result.response).toEqual({ message: "Invalid cursor" });
  }
});
