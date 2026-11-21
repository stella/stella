import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { normalizeUnicode } from "@stll/text-normalize";

import {
  CORPUS_QUERY_LEAF_BUDGET,
  corpusFreeTextClause,
} from "@/api/lib/legal-search/corpus-query";
import { relaxedLegislationClause } from "@/api/lib/legal-search/legislation-query";
import {
  FUNCTION_WORD_LANGUAGES,
  FUNCTION_WORDS,
} from "@/api/lib/legal-search/morphology/function-words";

test("relaxed legislation coverage ORs content words and drops Czech function words", () => {
  expect(
    relaxedLegislationClause({
      query: "jak musí být náhrada škody a výpověď",
      jurisdiction: "CZE",
    }),
  ).toBe('("náhrada" OR "škody" OR "výpověď")');
  expect(
    relaxedLegislationClause({ query: "náhrada škody", jurisdiction: "cze" }),
  ).toBe('("náhrada" OR "škody")');
});

test("relaxed legislation resolves explicit language before jurisdiction", () => {
  expect(
    relaxedLegislationClause({
      query: "the contract and jak",
      jurisdiction: "CZE",
      language: "EN",
    }),
  ).toBe('("contract" OR "jak")');
  expect(
    relaxedLegislationClause({ query: "jak náhrada", language: "cs" }),
  ).toBe('("náhrada")');
  expect(
    relaxedLegislationClause({ query: "the contract and", jurisdiction: "EU" }),
  ).toBe('("the" OR "contract" OR "and")');
  expect(
    relaxedLegislationClause({
      query: "jak náhrada",
      jurisdiction: "CZE",
      language: "unknown",
    }),
  ).toBe('("jak" OR "náhrada")');
});

test("dates, amounts and bare numbers do not contribute relaxed clauses", () => {
  expect(
    relaxedLegislationClause({
      query: "náhrada 1.1.2024 2024-01-01 89/2012 50 000 123,45 Kč 42",
      jurisdiction: "CZE",
    }),
  ).toBe('("náhrada" OR "Kč")');
  for (const query of ["", "?!():*", "1.1.2024 50 000 89/2012 42"]) {
    expect(relaxedLegislationClause({ query, jurisdiction: "CZE" })).toBeNull();
  }
});

test("section, paragraph and letter designations remain searchable", () => {
  expect(
    relaxedLegislationClause({
      query: "§2051 náhrada §52 odst. 2 písm. f) výpověď 1.1.2024 50 000 Kč",
      jurisdiction: "CZE",
    }),
  ).toBe('("2051" OR "52" OR "2" OR "f" OR "náhrada" OR "výpověď" OR "Kč")');
});

test("diacritic words after section markers remain whole words", () => {
  assertProperty(
    "diacritic words after section markers remain whole words",
    fc.property(
      fc.constantFrom("§", "odst.", "písm."),
      fc.constantFrom("návrh", "článek", "řád", "škoda", "úprava", "žádost"),
      fc.constantFrom("NFC", "NFD"),
      (marker, word, normalization) => {
        const query = normalizeUnicode(`${marker} ${word}`, normalization);
        const expected =
          marker === "§"
            ? `("${word}")`
            : `("${marker.slice(0, -1)}" OR "${word}")`;
        expect(relaxedLegislationClause({ query, jurisdiction: "CZE" })).toBe(
          expected,
        );
      },
    ),
  );
});

test("letter designations survive function-word filtering", () => {
  assertProperty(
    "letter designations survive function-word filtering",
    fc.property(
      fc.constantFrom("CZE", "SVK"),
      fc.constantFrom("a", "i", "o", "s", "u", "v", "z"),
      (jurisdiction, letter) => {
        expect(
          relaxedLegislationClause({
            query: `písm. ${letter}) náhrada`,
            jurisdiction,
          }),
        ).toBe(`("${letter}" OR "náhrada")`);
      },
    ),
  );
});

test("section designation preservation survives decomposed Czech diacritics", () => {
  const query = "písm. 3 náhrada";
  const decomposed = normalizeUnicode(query, "NFD");
  expect(decomposed).not.toBe(query);
  const expected = '("3" OR "náhrada")';
  expect(relaxedLegislationClause({ query, jurisdiction: "CZE" })).toBe(
    expected,
  );
  expect(
    relaxedLegislationClause({ query: decomposed, jurisdiction: "CZE" }),
  ).toBe(expected);
});

test("designation suffixes inside another word do not preserve bare numbers", () => {
  expect(
    relaxedLegislationClause({
      query: "neodst. 700 náhrada",
      jurisdiction: "CZE",
    }),
  ).toBe('("neodst" OR "náhrada")');
});

test("only numbers belonging to section designations survive noisy numeric queries", () => {
  assertProperty(
    "only numbers belonging to section designations survive noisy numeric queries",
    fc.property(
      fc.integer({ min: 1, max: 9999 }),
      fc.integer({ min: 2000, max: 2099 }),
      fc.integer({ min: 1, max: 28 }),
      (section, year, day) => {
        const clause = relaxedLegislationClause({
          query: `náhrada §${section} ${day}.12.${year} ${section + 100_000},50 Kč ${section + 200_000}`,
          jurisdiction: "CZE",
        });
        expect(clause).toBe(`("${section}" OR "náhrada" OR "Kč")`);
      },
    ),
  );
});

test("quoted phrases retain adjacency while syntax attempts stay literal", () => {
  expect(
    relaxedLegislationClause({
      query: "„náhrada škody“ a výpověď",
      jurisdiction: "CZE",
    }),
  ).toBe('("náhrada škody" OR "výpověď")');
  expect(
    relaxedLegislationClause({
      query: '"text:* AND court:X" smlouva',
      jurisdiction: "CZE",
    }),
  ).toBe('("text AND court X" OR "smlouva")');
  expect(
    relaxedLegislationClause({
      query: 'smlouva) OR (court:"X" AND text:*',
      jurisdiction: "CZE",
    }),
  ).toBe('("smlouva" OR "OR" OR "court" OR "X" OR "AND" OR "text")');
});

test("arbitrary relaxed input emits only quoted literal leaves within the budget", () => {
  assertProperty(
    "arbitrary relaxed input emits only quoted literal leaves within the budget",
    fc.property(fc.string(), (query) => {
      const clause = relaxedLegislationClause({ query, jurisdiction: "CZE" });
      if (clause === null) {
        return;
      }
      expect(clause).toMatch(
        /^\("[\p{L}\p{M}\p{N} ]+"(?: OR "[\p{L}\p{M}\p{N} ]+")*\)$/u,
      );
      expect((clause.match(/"/gu) ?? []).length / 2).toBeLessThanOrEqual(
        CORPUS_QUERY_LEAF_BUDGET,
      );
    }),
  );
});

test("long relaxed queries spend no more than the shared leaf budget", () => {
  const terms = Array.from(
    { length: CORPUS_QUERY_LEAF_BUDGET + 8 },
    (_, index) => `slovo${"a".repeat(index + 1)}`,
  );
  const clause = relaxedLegislationClause({
    query: terms.join(" "),
    jurisdiction: "CZE",
  });
  expect(clause).toBe(
    `(${terms
      .slice(0, CORPUS_QUERY_LEAF_BUDGET)
      .map((term) => `"${term}"`)
      .join(" OR ")})`,
  );
});

test("a section at the end of a long relaxed query cannot be budgeted away", () => {
  assertProperty(
    "a section at the end of a long relaxed query cannot be budgeted away",
    fc.property(
      fc.array(fc.constantFrom("náhrada", "škody", "smlouva"), {
        minLength: CORPUS_QUERY_LEAF_BUDGET,
        maxLength: CORPUS_QUERY_LEAF_BUDGET * 3,
      }),
      fc.integer({ min: 1, max: 9999 }),
      (words, section) => {
        const clause = relaxedLegislationClause({
          query: `${words.join(" ")} §${section} odst. 2 písm. f)`,
          jurisdiction: "CZE",
        });
        expect(clause).toStartWith(`("${section}" OR "2" OR "f" OR `);
        expect((clause?.match(/"/gu) ?? []).length / 2).toBeLessThanOrEqual(
          CORPUS_QUERY_LEAF_BUDGET,
        );
      },
    ),
  );
});

test("relaxed coverage excludes function-word-only queries in every supported language", () => {
  assertProperty(
    "relaxed coverage excludes function-word-only queries in every supported language",
    fc.property(
      fc.constantFrom(...FUNCTION_WORD_LANGUAGES).chain((language) =>
        fc.record({
          language: fc.constant(language),
          words: fc.array(fc.constantFrom(...FUNCTION_WORDS[language]), {
            minLength: 1,
            maxLength: 20,
          }),
          normalization: fc.constantFrom("NFC", "NFD"),
        }),
      ),
      ({ language, words, normalization }) => {
        const query = normalizeUnicode(words.join(" "), normalization);
        expect(
          corpusFreeTextClause(query, {
            functionWords: FUNCTION_WORDS[language],
          }),
        ).not.toBeNull();
        expect(relaxedLegislationClause({ query, language })).toBeNull();
        expect(
          relaxedLegislationClause({ query: `"${query}"`, language }),
        ).not.toBeNull();
      },
    ),
  );
});
