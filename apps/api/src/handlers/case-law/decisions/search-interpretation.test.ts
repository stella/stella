import { describe, expect, test } from "bun:test";
import type { Static } from "elysia";

import { parseDecisionQuery } from "@stll/api-contract/decision-query-intent";

import {
  interpretDecisionQuery,
  narrowingFilters,
  searchAnswer,
} from "@/api/handlers/case-law/decisions/search-interpretation";
import type { searchDecisionsBodySchema } from "@/api/handlers/case-law/decisions/search-schema";
import { decisionDocketGrammarForCountry } from "@/api/lib/legal-search/adapter-manifest";
import { corpusFreeTextClause } from "@/api/lib/legal-search/corpus-query";

type SearchDecisionsBody = Static<typeof searchDecisionsBodySchema>;

/** The question that returned nothing: nine words, five of them grammar. */
const QUESTION = "jak velký musí být dluh na nájemném pro výpověď z nájmu";

const request = (
  overrides: Partial<SearchDecisionsBody> = {},
): SearchDecisionsBody => ({
  country: "CZE",
  query: QUESTION,
  ...overrides,
});

const interpret = (body: SearchDecisionsBody) =>
  interpretDecisionQuery(
    body,
    parseDecisionQuery(body.query, {
      grammar: decisionDocketGrammarForCountry(body.country),
    }),
  );

/**
 * The clause the engine receives, without stemming or expansion so the
 * assertion is the exclusion itself rather than a generation's field list.
 */
const clauseOf = (body: SearchDecisionsBody): string | null =>
  corpusFreeTextClause(body.query, {
    functionWords: interpret(body).functionWords,
  });

describe("interpretDecisionQuery", () => {
  test("a question keeps its subject matter and drops its grammar", () => {
    const { droppedFunctionWords, queryUsed } = interpret(request());

    expect(queryUsed).toBe("velký dluh nájemném výpověď nájmu");
    expect(droppedFunctionWords).toEqual([
      "jak",
      "musí",
      "být",
      "na",
      "pro",
      "z",
    ]);
  });

  test("the clause the engine receives requires only those words", () => {
    expect(clauseOf(request())).toBe(
      '("velký" AND "dluh" AND "nájemném" AND "výpověď" AND "nájmu")',
    );
  });

  test("strict requires every word, and reports the query untouched", () => {
    const body = request({ strict: true });
    const { droppedFunctionWords, queryUsed } = interpret(body);

    expect(queryUsed).toBe(QUESTION);
    expect(droppedFunctionWords).toEqual([]);
    // Byte for byte the clause this query built before the exclusion existed.
    expect(clauseOf(body)).toBe(
      '("jak" AND "velký" AND "musí" AND "být" AND "dluh" AND "na" AND "nájemném" AND "pro" AND "výpověď" AND "z" AND "nájmu")',
    );
  });

  test("an identifier is matched as written", () => {
    // "z" would be a Czech function word in prose; inside a docket it is a
    // senate marker, and dropping it would ask for a different decision.
    const body = request({ query: "22 Cdo 1000/2020" });
    const { droppedFunctionWords, queryUsed } = interpret(body);

    expect(queryUsed).toBe("22 Cdo 1000/2020");
    expect(droppedFunctionWords).toEqual([]);
    expect(interpret(body).functionWords).toBeNull();
  });

  test("a quoted phrase keeps every word it asked to match adjacently", () => {
    const body = request({ query: 'dluh "výpověď z nájmu" a náhrada' });
    const { droppedFunctionWords, queryUsed } = interpret(body);

    // The phrase's own "z" survives; the loose "a" beside it does not.
    expect(queryUsed).toBe('dluh "výpověď z nájmu" náhrada');
    expect(droppedFunctionWords).toEqual(["a"]);
    expect(clauseOf(body)).toBe('("dluh" AND "výpověď z nájmu" AND "náhrada")');
  });

  test("a negated question keeps what makes it negative", () => {
    // Dropping "není" or "bez" here would hand a reader researching invalid
    // contracts the decisions about valid ones, which is the other side of
    // their question rather than a wider answer to it.
    const body = request({ query: "smlouva není platná bez podpisu" });
    const { droppedFunctionWords, queryUsed } = interpret(body);

    expect(queryUsed).toBe("smlouva není platná bez podpisu");
    expect(droppedFunctionWords).toEqual([]);
  });

  test("a query with no resolved language drops nothing", () => {
    // The European index spans 24 languages under one jurisdiction, so no one
    // list describes the reader's words unless the request names a language.
    const body = request({ country: "EU", query: "state aid and the market" });
    const { droppedFunctionWords, queryUsed } = interpret(body);

    expect(queryUsed).toBe("state aid and the market");
    expect(droppedFunctionWords).toEqual([]);
  });

  test("a language the request names decides, over the jurisdiction", () => {
    const body = request({
      country: "EU",
      language: "en",
      query: "state aid and the market",
    });

    expect(interpret(body).queryUsed).toBe("state aid market");
  });

  test("a query made only of function words stays as strict as it was", () => {
    // Nothing would remain to search for, and a clause built from nothing is
    // not a broader search.
    const body = request({ query: "jak a kdy" });
    const { droppedFunctionWords, queryUsed } = interpret(body);

    expect(queryUsed).toBe("jak a kdy");
    expect(droppedFunctionWords).toEqual([]);
    expect(clauseOf(body)).toBe('("jak" AND "a" AND "kdy")');
  });

  test("legal alternatives apply to the words searched, never under strict", () => {
    const body = request({
      query: "vrácení kauce",
      alternatives: [
        { term: "kauce", alternatives: ["jistota"] },
        { term: "nájem", alternatives: ["pacht"] },
      ],
    });

    expect(interpret(body).legalAlternatives).toEqual([
      { term: "kauce", alternatives: ["jistota"] },
    ]);
    expect(interpret({ ...body, strict: true }).legalAlternatives).toEqual([]);
    // What the reader is told was searched stays the words they typed.
    expect(interpret(body).queryUsed).toBe("vrácení kauce");
  });

  test("an identifier carries no legal alternatives", () => {
    const body = request({
      query: "22 Cdo 1000/2020",
      alternatives: [{ term: "Cdo", alternatives: ["dovolání"] }],
    });

    expect(interpret(body).legalAlternatives).toEqual([]);
  });

  test("a query of content words alone is unchanged", () => {
    const body = request({ query: "nájemné výpověď" });

    expect(interpret(body).queryUsed).toBe("nájemné výpověď");
    expect(clauseOf(body)).toBe('("nájemné" AND "výpověď")');
  });
});

describe("narrowingFilters", () => {
  test("names the filters that cut the result set", () => {
    expect(
      narrowingFilters(
        request({ court: "Nejvyšší soud", dateFrom: "2020-01-01" }),
      ),
    ).toEqual(["court", "dateFrom"]);
  });

  test("an option that only shapes the page is not a filter", () => {
    // A reader cannot widen an empty result by changing the order or the
    // page size, so neither may be blamed for one.
    expect(
      narrowingFilters(
        request({ limit: 5, sort: "newest", strict: true, cursor: "abc" }),
      ),
    ).toEqual([]);
  });

  test("country is not a filter a reader can drop", () => {
    expect(narrowingFilters(request())).toEqual([]);
  });
});

describe("searchAnswer", () => {
  const answerFor = (
    body: SearchDecisionsBody,
    hitCount: number,
    countsResultSet = true,
  ) =>
    searchAnswer({
      body,
      interpretation: interpret(body),
      hitCount,
      countsResultSet,
    });

  test("a page with hits reports what was searched and why", () => {
    const { queryUsed, warnings } = answerFor(request(), 10);

    expect(queryUsed).toBe("velký dluh nájemném výpověď nájmu");
    expect(warnings.map(({ code }) => code)).toEqual([
      "function_words_optional",
    ]);
    expect(warnings[0]?.message).toContain("jak, musí, být, na, pro, z");
  });

  test("an empty page says nothing matched", () => {
    expect(
      answerFor(request({ strict: true }), 0).warnings.map(({ code }) => code),
    ).toEqual(["no_hits"]);
  });

  test("an empty page under a filter blames the filter", () => {
    expect(
      answerFor(request({ strict: true, court: "Nejvyšší soud" }), 0).warnings,
    ).toEqual([
      {
        code: "no_hits_filtered",
        message:
          "Nothing matched under the filters this search narrowed with: court.",
        hint: "Drop or widen that filter and search again; the same words may match outside it.",
      },
    ]);
  });

  test("an empty continuation page is the end of a page, not of a search", () => {
    expect(
      answerFor(request({ strict: true, cursor: "abc" }), 0, false).warnings,
    ).toEqual([]);
  });

  test("a strict page with hits carries no warning at all", () => {
    expect(answerFor(request({ strict: true }), 3).warnings).toEqual([]);
  });
});
