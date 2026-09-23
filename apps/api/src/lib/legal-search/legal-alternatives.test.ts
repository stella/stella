import { Value } from "@sinclair/typebox/value";
import { describe, expect, test } from "bun:test";

import { corpusFreeTextClause } from "@/api/lib/legal-search/corpus-query";
import {
  LEGAL_ALTERNATIVES_LIMITS,
  legalAlternativesExpander,
  normalizeLegalAlternatives,
  tLegalAlternatives,
  withLegalAlternativesIdentity,
} from "@/api/lib/legal-search/legal-alternatives";
import {
  NO_EXPANSION_DICTIONARY_IDENTITY,
  isMorphologyDictionaryContentHash,
  serializeExpansionDictionaryIdentity,
} from "@/api/lib/legal-search/morphology/dictionary";
import { FUNCTION_WORDS } from "@/api/lib/legal-search/morphology/function-words";

const CZECH = { functionWords: FUNCTION_WORDS.cs };

describe("normalizeLegalAlternatives", () => {
  test("keeps an alternative for a word the search requires", () => {
    expect(
      normalizeLegalAlternatives(
        [{ term: "kauce", alternatives: ["Jistota"] }],
        { ...CZECH, query: "Jak vrátit kauce?" },
      ),
    ).toEqual([{ term: "kauce", alternatives: ["jistota"] }]);
  });

  test("drops words the query does not carry, function words and phrases", () => {
    expect(
      normalizeLegalAlternatives(
        [
          { term: "nájem", alternatives: ["pacht"] },
          { term: "jak", alternatives: ["způsob"] },
          { term: "kauce", alternatives: ["jistota"] },
        ],
        { ...CZECH, query: 'jak "vrácení kauce"' },
      ),
    ).toEqual([]);
  });

  test("rejects the word itself, duplicates, empty and overlong alternatives", () => {
    expect(
      normalizeLegalAlternatives(
        [
          {
            term: "kauce",
            alternatives: [
              "KAUCE",
              "jistota",
              "jistota",
              "?!",
              "peněžitá jistota nájemce bytu",
            ],
          },
        ],
        { ...CZECH, query: "kauce" },
      ),
    ).toEqual([{ term: "kauce", alternatives: ["jistota"] }]);
  });

  test("merges a word proposed twice and keeps the query's order", () => {
    expect(
      normalizeLegalAlternatives(
        [
          { term: "majitel", alternatives: ["vlastník"] },
          { term: "kauce", alternatives: ["jistota"] },
          { term: "majitel", alternatives: ["vlastník", "pronajímatel"] },
        ],
        { ...CZECH, query: "kauce majitel" },
      ),
    ).toEqual([
      { term: "kauce", alternatives: ["jistota"] },
      { term: "majitel", alternatives: ["vlastník", "pronajímatel"] },
    ]);
  });

  test("the answer always fits the wire schema the search accepts", () => {
    const words = Array.from({ length: 12 }, (_, index) => `slovo${String(index)}`);
    const normalized = normalizeLegalAlternatives(
      words.map((term) => ({
        term,
        alternatives: Array.from({ length: 6 }, (_, index) => `${term}x${String(index)}`),
      })),
      { functionWords: null, query: words.join(" ") },
    );

    expect(normalized).toHaveLength(LEGAL_ALTERNATIVES_LIMITS.terms);
    expect(Value.Check(tLegalAlternatives, normalized)).toBe(true);
    // A fixed point: the search normalizes what it receives again.
    expect(
      normalizeLegalAlternatives(normalized, {
        functionWords: null,
        query: words.join(" "),
      }),
    ).toEqual(normalized);
  });
});

describe("legalAlternativesExpander", () => {
  test("is absent when there is nothing to add", () => {
    expect(legalAlternativesExpander([])).toBeNull();
  });

  test("feeds the clause the alternative with its stems", () => {
    const clause = corpusFreeTextClause("vrácení kauce", {
      legalAlternatives: legalAlternativesExpander([
        { term: "kauce", alternatives: ["jistota"] },
      ]),
      stemming: { language: "cs", fields: ["text_stem"] },
    });

    expect(clause).toContain('("kauce" OR ');
    expect(clause).toContain('"jistota" OR text_stem:"jistot"');
  });
});

describe("withLegalAlternativesIdentity", () => {
  test("leaves the identity alone when a query carries none", () => {
    expect(
      withLegalAlternativesIdentity(NO_EXPANSION_DICTIONARY_IDENTITY, []),
    ).toBe(NO_EXPANSION_DICTIONARY_IDENTITY);
  });

  test("pins the alternatives, so another set is a different ranking", () => {
    const one = withLegalAlternativesIdentity(NO_EXPANSION_DICTIONARY_IDENTITY, [
      { term: "kauce", alternatives: ["jistota"] },
    ]);
    const other = withLegalAlternativesIdentity(
      NO_EXPANSION_DICTIONARY_IDENTITY,
      [{ term: "kauce", alternatives: ["záloha"] }],
    );

    const serialized = serializeExpansionDictionaryIdentity(one);
    // Written into the cursor's existing segment, in the form it parses.
    expect(isMorphologyDictionaryContentHash(serialized)).toBe(true);
    expect(serialized).not.toBe(serializeExpansionDictionaryIdentity(other));
  });
});
