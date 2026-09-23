import { describe, expect, test } from "bun:test";

import {
  CASE_LAW_REFINE_MAX_TERMS,
  caseLawRefineOutputSchema,
  normalizeCaseLawRefinedQuery,
} from "@/api/handlers/case-law/decisions/search-refine-query";
import { toJsonSchema } from "@/api/lib/json-schema/valibot-to-json-schema";
import {
  corpusFreeTextClause,
  tokenizeCorpusFreeText,
} from "@/api/lib/legal-search/corpus-query";
import { FUNCTION_WORDS } from "@/api/lib/legal-search/morphology/function-words";

const CZECH = FUNCTION_WORDS.cs;

describe("normalizeCaseLawRefinedQuery", () => {
  test("returns exactly the words the search will require", () => {
    const refined = normalizeCaseLawRefinedQuery(
      "vrácení jistoty pronajímatelem",
      CZECH,
    );

    expect(refined.isOk()).toBe(true);
    const query = refined.unwrapOr("");
    // Re-reading the answer as a search changes nothing: the reader is shown
    // the query that runs, not one the search would still rewrite.
    expect(normalizeCaseLawRefinedQuery(query, CZECH).unwrapOr(null)).toBe(
      query,
    );
    expect(corpusFreeTextClause(query, { functionWords: CZECH })).toBe(
      corpusFreeTextClause("vrácení jistoty pronajímatelem"),
    );
  });

  test("drops the function words the search would drop anyway", () => {
    expect(
      normalizeCaseLawRefinedQuery("lhůta pro vrácení jistoty", CZECH).unwrapOr(
        null,
      ),
    ).toBe("lhůta vrácení jistoty");
  });

  test("keeps a phrase the model quoted as one phrase", () => {
    const query = normalizeCaseLawRefinedQuery(
      "„smlouva o nájmu“ jistota",
      CZECH,
    ).unwrapOr("");

    expect(tokenizeCorpusFreeText(query)).toEqual([
      { type: "phrase", value: "smlouva o nájmu" },
      { type: "term", value: "jistota" },
    ]);
  });

  test.each(["jistota OR kauce", "jistota AND vrácení", "NOT kauce"])(
    "rejects workspace boolean syntax, which would be required as words: %s",
    (text) => {
      expect(normalizeCaseLawRefinedQuery(text, CZECH).isErr()).toBe(true);
    },
  );

  test("rejects an answer with no searchable word", () => {
    expect(normalizeCaseLawRefinedQuery("?!", CZECH).isErr()).toBe(true);
  });

  test("rejects more required words than the search can usefully AND", () => {
    const words = Array.from(
      { length: CASE_LAW_REFINE_MAX_TERMS + 1 },
      (_, index) => `slovo${String(index)}`,
    ).join(" ");

    expect(normalizeCaseLawRefinedQuery(words, CZECH).isErr()).toBe(true);
    // Function words do not count against the limit: the search drops them.
    expect(
      normalizeCaseLawRefinedQuery(
        `jak ${words.split(" ").slice(1).join(" ")} a`,
        CZECH,
      ).isOk(),
    ).toBe(true);
  });

  test("with no corpus language, requires every word", () => {
    expect(
      normalizeCaseLawRefinedQuery("state aid market", null).unwrapOr(null),
    ).toBe("state aid market");
  });
});

test("the output schema converts to JSON Schema for structured output", () => {
  expect(() => toJsonSchema(caseLawRefineOutputSchema)).not.toThrow();
});
