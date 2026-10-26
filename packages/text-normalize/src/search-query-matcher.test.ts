import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  createSearchQueryMatcher,
  filterBySearchQuery,
  foldSearchMatchText,
} from "./search-match.js";

const SCRIPT_CHARACTERS = [
  ..."abzAZ áčěŘšůžłøđßæœﬁİıΣσςمحمدًٌَ٢0-😀",
  "e\u0301",
  "\ud800",
  "\udc00",
];

const text = fc
  .array(fc.constantFrom(...SCRIPT_CHARACTERS), { maxLength: 16 })
  .map((parts) => parts.join(""));

/**
 * What a user types against what the list shows, at least one row per UI
 * language plus Turkish dotted and dotless i. Every row matches in both
 * directions: the accented spelling also finds the plain one.
 */
const LANGUAGE_CASES = [
  { language: "ar", shown: "مُحَمَّد", typed: "محمد" },
  { language: "ar", shown: "أحمد", typed: "احمد" },
  { language: "ar", shown: "مدرسة", typed: "مدرسه" },
  { language: "cs", shown: "Dvořák", typed: "dvorak" },
  { language: "de", shown: "Straße", typed: "strasse" },
  { language: "de", shown: "Müller", typed: "muller" },
  { language: "en", shown: "Café", typed: "cafe" },
  { language: "es", shown: "Peña", typed: "pena" },
  { language: "et", shown: "Õismäe", typed: "oismae" },
  { language: "fr", shown: "Élise", typed: "elise" },
  { language: "hu", shown: "Erdős", typed: "erdos" },
  { language: "lt", shown: "Šiaulių", typed: "siauliu" },
  { language: "lv", shown: "Ķegums", typed: "kegums" },
  { language: "pl", shown: "Łódź", typed: "lodz" },
  { language: "pt-BR", shown: "Conceição", typed: "conceicao" },
  { language: "sk", shown: "Ľubomír", typed: "lubomir" },
  { language: "tr", shown: "İstanbul", typed: "istanbul" },
  { language: "tr", shown: "ISTANBUL", typed: "ıstanbul" },
] as const;

describe("createSearchQueryMatcher", () => {
  for (const { language, shown, typed } of LANGUAGE_CASES) {
    test(`${language}: "${typed}" finds "${shown}" and back`, () => {
      expect(createSearchQueryMatcher(typed)(shown)).toBe(true);
      expect(createSearchQueryMatcher(typed.toUpperCase())(shown)).toBe(true);
      expect(createSearchQueryMatcher(typed)(`(${shown}), s.r.o.`)).toBe(true);
      expect(createSearchQueryMatcher(shown)(typed)).toBe(true);
    });
  }

  test("folds compatibility ligatures and letters without a decomposition", () => {
    expect(createSearchQueryMatcher("final")("ﬁnal")).toBe(true);
    expect(createSearchQueryMatcher("aesir")("Æsir")).toBe(true);
    expect(createSearchQueryMatcher("oresund")("Øresund")).toBe(true);
  });

  test("still tells different words apart", () => {
    expect(createSearchQueryMatcher("dvorak")("Dvořáková")).toBe(true);
    expect(createSearchQueryMatcher("dvorakova")("Dvořák")).toBe(false);
    expect(createSearchQueryMatcher("strase")("Straße")).toBe(false);
  });

  test("trims the query; a blank query matches everything", () => {
    expect(createSearchQueryMatcher("  dvorak  ")("Dvořák")).toBe(true);
    expect(createSearchQueryMatcher("   ")("anything")).toBe(true);
    expect(createSearchQueryMatcher("")(null)).toBe(true);
  });

  test("never matches half of an astral character", () => {
    expect(createSearchQueryMatcher("\ude00")("😀")).toBe(false);
    expect(createSearchQueryMatcher("\udc00")("a\ud800")).toBe(true);
  });

  test("a missing candidate never matches a real query", () => {
    expect(createSearchQueryMatcher("a")(null)).toBe(false);
    expect(createSearchQueryMatcher("a")(undefined)).toBe(false);
    expect(createSearchQueryMatcher("a")("")).toBe(false);
  });

  /**
   * Every trimmed slice of a text, in any case, finds that text: the fold is
   * applied per character, so cutting the text never splits a match key.
   */
  test("finds every slice of a text, in either case", () => {
    assertProperty(
      "search query matcher finds every slice of its text",
      fc.property(
        text,
        fc.nat(),
        fc.nat(),
        fc.boolean(),
        (value, from, to, upper) => {
          const characters = [...value];
          const start = from % (characters.length + 1);
          const end = start + (to % (characters.length - start + 1));
          const slice = characters.slice(start, end).join("");
          const query = upper ? slice.toUpperCase() : slice;
          expect(createSearchQueryMatcher(query)(value)).toBe(true);
        },
      ),
    );
  });
});

describe("candidate key cache", () => {
  /** Cached or not, a verdict is the folded containment the contract names. */
  test("agrees with folding both sides on every call", () => {
    assertProperty(
      "search query matcher agrees with folded containment",
      fc.property(text, text, (candidate, query) => {
        const expected = foldSearchMatchText(candidate.toWellFormed()).includes(
          foldSearchMatchText(query.trim().toWellFormed()),
        );
        const matches = createSearchQueryMatcher(query);
        expect(matches(candidate)).toBe(expected);
        expect(matches(candidate)).toBe(expected);
      }),
    );
  });

  test("keeps answering correctly after it fills and clears", () => {
    const matches = createSearchQueryMatcher("dvorak");
    for (let index = 0; index < 10_050; index += 1) {
      expect(matches(`Dvořák ${index}`)).toBe(true);
      expect(matches(`Novák ${index}`)).toBe(false);
    }
  });
});

describe("filterBySearchQuery", () => {
  const people = [
    { name: "Antonín Dvořák", email: "dvorak@example.com" },
    { name: "Jana Nováková", email: null },
    { name: "Élise Dupré", email: "elise@example.fr" },
  ];

  test("keeps the items any field of which matches, in order", () => {
    expect(
      filterBySearchQuery({
        items: people,
        query: "NOVAK",
        fields: ({ email, name }) => [name, email],
      }),
    ).toEqual([people[1]]);
    expect(
      filterBySearchQuery({
        items: people,
        query: "example",
        fields: ({ email, name }) => [name, email],
      }),
    ).toEqual([people[0], people[2]]);
  });

  test("keeps every item for a blank query", () => {
    expect(
      filterBySearchQuery({
        items: people,
        query: " ",
        fields: ({ name }) => [name],
      }),
    ).toEqual(people);
  });
});
