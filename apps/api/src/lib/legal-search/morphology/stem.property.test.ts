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
      const lowercased = input.toLowerCase();
      const stem = stemLegalTerm(input, code);

      expect<number>(stem.length).toBeLessThanOrEqual(lowercased.length);
      expect<boolean>(stem.length > 0).toBe(true);
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
