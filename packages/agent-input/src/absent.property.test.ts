import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import { ABSENT_PLACEHOLDERS, isAbsentPlaceholder } from "./absent";

/** Mixed case, one character at a time, so `nOnE` and `N/a` are covered. */
const randomCase = (word: string, flips: readonly boolean[]): string =>
  [...word]
    .map((char, index) =>
      flips[index % flips.length] === true ? char.toUpperCase() : char,
    )
    .join("");

const whitespaceArb = fc
  .array(fc.constantFrom(" ", "\t", "\n", " "), { maxLength: 3 })
  .map((chars) => chars.join(""));

describe("placeholders on optional filters", () => {
  test("every placeholder word is absent in any case and spacing", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ABSENT_PLACEHOLDERS),
        fc.array(fc.boolean(), { minLength: 1, maxLength: 8 }),
        whitespaceArb,
        whitespaceArb,
        (word, flips, before, after) => {
          const spelled = `${before}${randomCase(word, flips)}${after}`;
          expect(isAbsentPlaceholder(spelled)).toBe(true);
        },
      ),
      propertyConfig({ numRuns: 300 }),
    );
  });

  test("a blank string is absent", () => {
    fc.assert(
      fc.property(whitespaceArb, (blank) => {
        expect(isAbsentPlaceholder(blank)).toBe(true);
      }),
      propertyConfig({ numRuns: 100 }),
    );
  });

  test("a word outside the set is a value, not a placeholder", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-zA-Z0-9]{5,20}$/u), (word) => {
        fc.pre(
          !ABSENT_PLACEHOLDERS.some(
            (placeholder) => placeholder === word.toLowerCase(),
          ),
        );
        expect(isAbsentPlaceholder(word)).toBe(false);
      }),
      propertyConfig({ numRuns: 300 }),
    );
  });
});
