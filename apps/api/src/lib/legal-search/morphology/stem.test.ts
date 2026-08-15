import { describe, expect, test } from "bun:test";

import {
  MORPHOLOGY_LANGUAGES,
  stemLegalTerm,
} from "@/api/lib/legal-search/morphology/stem";

/**
 * One legal paradigm per language, chosen so a stemmer that silently became
 * an identity function (a broken generated module, a dispatch wired to the
 * wrong language) fails here.
 */
const PARADIGMS = {
  cs: [
    ["rozsudku", "rozsudk"],
    ["smlouvy", "smlouv"],
    ["žalobě", "žalob"],
    ["soudu", "soud"],
  ],
  pl: [
    ["wyroku", "wyrok"],
    ["umowy", "umow"],
    ["sądu", "sąd"],
    ["skargi", "skarg"],
  ],
  sk: [
    ["rozsudkom", "rozsudk"],
    ["zmluvy", "zmluv"],
    ["žalobami", "žalob"],
    ["súdoch", "súd"],
  ],
} as const satisfies Record<
  (typeof MORPHOLOGY_LANGUAGES)[number],
  readonly (readonly [string, string])[]
>;

describe("stemLegalTerm", () => {
  test("every declared language is dispatched, and only those", () => {
    // Both directions: the paradigm table and the exported language list must
    // agree, so adding a language without a paradigm (or vice versa) fails.
    expect<readonly string[]>(Object.keys(PARADIGMS).toSorted()).toEqual(
      [...MORPHOLOGY_LANGUAGES].toSorted(),
    );
  });

  for (const language of MORPHOLOGY_LANGUAGES) {
    test(`${language} stems inflected legal forms`, () => {
      const vectors = PARADIGMS[language];
      const actual = vectors.map(([word]) => [
        word,
        stemLegalTerm(word, language),
      ]);

      expect<readonly (readonly string[])[]>(actual).toEqual(
        vectors.map(([word, stem]) => [word, stem]),
      );

      // Non-trivial: a pass-through stemmer would leave every form untouched.
      expect<boolean>(
        vectors.some(([word]) => stemLegalTerm(word, language) !== word),
      ).toBe(true);
    });

    test(`${language} lowercases before stemming`, () => {
      const [vector] = PARADIGMS[language];
      const [word] = vector;

      expect<string>(stemLegalTerm(word.toUpperCase(), language)).toBe(
        stemLegalTerm(word, language),
      );
    });
  }

  test("folding before stemming strands endings, which is why callers fold after", () => {
    // The ordering is load-bearing, not stylistic: the suffix tables are
    // written over accented characters, so a pre-folded term keeps the
    // ending the stemmer exists to strip. Measured over the committed
    // conformance vocabularies, fold-then-stem diverges from stem-then-fold
    // on ~16% of Czech and ~9% of Polish words; two of them:
    expect<string>(stemLegalTerm("absolutních", "cs")).toBe("absolutn");
    expect<string>(stemLegalTerm("absolutnich", "cs")).toBe("absolutnich");

    expect<string>(stemLegalTerm("absolwentów", "pl")).toBe("absolwent");
    expect<string>(stemLegalTerm("absolwentow", "pl")).toBe("absolwentow");
  });
});
