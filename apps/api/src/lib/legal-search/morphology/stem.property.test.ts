/**
 * Invariants the stemmers must hold for every language over arbitrary input.
 *
 * The corpus feeds these stemmers whatever survives tokenisation, including
 * citation fragments, mixed scripts, and mojibake. The properties below are
 * what downstream indexing relies on: a stem never grows, never becomes
 * empty for non-empty input, and never throws.
 */

import { expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import {
  MORPHOLOGY_LANGUAGES,
  stemLegalTerm,
} from "@/api/lib/legal-search/morphology/stem";

const language = fc.constantFrom(...MORPHOLOGY_LANGUAGES);

/**
 * Deliberately wider than real tokens: Latin with Czech, Polish, and Slovak
 * diacritics, plus digits, astral-plane characters, and combining marks.
 */
const LEGAL_ALPHABET =
  "abcdefghijklmnopqrstuvwxyzáäčďéěíĺľňóôŕřšťúůýžąćęłńśźż0123456789'-".split(
    "",
  );

const term = fc.oneof(
  fc.string({ minLength: 1, maxLength: 40 }),
  fc.string({
    unit: fc.constantFrom(...LEGAL_ALPHABET),
    minLength: 1,
    maxLength: 40,
  }),
  fc.string({ unit: "grapheme", minLength: 1, maxLength: 40 }),
);

test("a stem never grows and never empties a non-empty term", () => {
  fc.assert(
    fc.property(term, language, (input, code) => {
      // Bounded against what the stemmer actually sees, not the raw input:
      // NFC can lengthen a string. U+1D1BB decomposes canonically and is on
      // the composition-exclusion list, so normalising it yields two code
      // points, never one. That growth is normalisation's, not the
      // stemmer's; see the pinned vector in stem.test.ts.
      //
      // The one letter a stemmer itself expands is the German sharp s: the
      // algorithm's prelude rewrites it as "ss" before any suffix is removed,
      // so a term ending in it can come back one code point longer per sharp
      // s. The bound allows exactly that expansion and nothing else.
      const normalized = input.normalize("NFC").toLowerCase();
      const bound =
        code === "de"
          ? normalized.replaceAll("ß", "ss").length
          : normalized.length;
      const stem = stemLegalTerm(input, code);

      expect<number>(stem.length).toBeLessThanOrEqual(bound);
      expect<boolean>(stem.length > 0).toBe(true);
    }),
    propertyConfig({ numRuns: 2000 }),
  );
});

/**
 * Latin letters that carry a combining mark in NFD, so the generated strings
 * genuinely differ between the two normal forms rather than being NFC-stable
 * by accident.
 */
const DECOMPOSABLE_ALPHABET =
  "áäčďéěíĺľňóôŕřšťúůýžąćęńóśźżàâãåèêëìîïòõùûü".split("");

const decomposableTerm = fc.string({
  unit: fc.constantFrom(
    ...DECOMPOSABLE_ALPHABET,
    ..."abcdefghijklmnop".split(""),
  ),
  minLength: 1,
  maxLength: 40,
});

test("normalisation form does not change the stem", () => {
  // Extracted text arrives in whichever normal form its producer used, so
  // the same word must not index one way and query another.
  fc.assert(
    fc.property(decomposableTerm, language, (input, code) => {
      expect<string>(stemLegalTerm(input.normalize("NFD"), code)).toBe(
        stemLegalTerm(input.normalize("NFC"), code),
      );
    }),
    propertyConfig({ numRuns: 2000 }),
  );
});

test("stemming is deterministic across a shared stemmer instance", () => {
  fc.assert(
    fc.property(
      fc.array(term, { minLength: 2, maxLength: 20 }),
      language,
      (inputs, code) => {
        const first = inputs.map((input) => stemLegalTerm(input, code));
        const second = inputs.map((input) => stemLegalTerm(input, code));

        expect<readonly string[]>(second).toEqual(first);
      },
    ),
    propertyConfig({ numRuns: 500 }),
  );
});
