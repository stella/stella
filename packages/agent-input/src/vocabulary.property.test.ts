import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";
import { foldToAscii } from "@stll/text-normalize";

import { ABSENT_PLACEHOLDERS, isAbsentPlaceholder } from "./absent";
import type { VocabularyEntry } from "./vocabulary";
import { normalizeVocabularyValue } from "./vocabulary";

/** Letters with and without the diacritics court names carry, so stripping
 *  them is a real change for most generated words. */
const LETTERS = "aábcčdďeéěfghiíjklmnňoópqrřsštťuúůvwxyýzž".split("");

const wordArb = fc
  .array(fc.constantFrom(...LETTERS), { minLength: 3, maxLength: 8 })
  .map((letters) => letters.join(""));

const nameArb = fc
  .array(wordArb, { minLength: 1, maxLength: 3 })
  .map((words) => words.join(" "));

/** The folded tokens of a generated name: letters only, so this is the whole
 *  comparison form. */
const tokens = (name: string): string[] =>
  foldToAscii(name).toLowerCase().split(" ");

const key = (name: string): string => tokens(name).join(" ");

/** Names whose folded forms are pairwise distinct and none a placeholder, so
 *  each names one entry. */
const distinctNamesArb = (minLength: number, maxLength: number) =>
  fc
    .uniqueArray(nameArb, { minLength, maxLength, selector: key })
    .filter((names) => names.every((name) => !isAbsentPlaceholder(name)));

const vocabularyArb = distinctNamesArb(1, 8).map((names) =>
  names.map((value): VocabularyEntry => ({ value })),
);

/** Two names per entry, value and alias, all distinct across the vocabulary. */
const aliasedVocabularyArb = distinctNamesArb(2, 12)
  .filter((names) => names.length % 2 === 0)
  .map((names) =>
    Array.from({ length: names.length / 2 }, (_, index): VocabularyEntry => ({
      value: names[index * 2] ?? "",
      aliases: [names[index * 2 + 1] ?? ""],
    })),
  );

/** The noise a name picks up between the data and the model: case, stripped
 *  diacritics, spacing, trailing punctuation, quotes, and word joiners. */
type Noise = {
  strip: boolean;
  upper: boolean;
  joiner: string;
  wrap: readonly [string, string];
};

const noiseArb: fc.Arbitrary<Noise> = fc.record({
  strip: fc.boolean(),
  upper: fc.boolean(),
  joiner: fc.constantFrom(" ", "  ", "-", "_"),
  wrap: fc.constantFrom<readonly [string, string]>(
    ["", ""],
    ['"', '"'],
    ["(", ")"],
    ["", "."],
    [" ", ","],
  ),
});

const withNoise = (
  name: string,
  { strip, upper, joiner, wrap }: Noise,
): string => {
  const stripped = strip ? foldToAscii(name) : name;
  const cased = upper ? stripped.toUpperCase() : stripped;
  return `${wrap[0]}${cased.split(" ").join(joiner)}${wrap[1]}`;
};

const valueOf = (
  result: ReturnType<typeof normalizeVocabularyValue>,
): string | null => (result.ok === true ? result.value : null);

describe("values drawn from data", () => {
  test("every value reads back through case, diacritic and punctuation noise", () => {
    fc.assert(
      fc.property(vocabularyArb, fc.nat(), noiseArb, (entries, pick, noise) => {
        const entry = entries[pick % entries.length];
        fc.pre(entry !== undefined);
        expect(
          valueOf(
            normalizeVocabularyValue(withNoise(entry.value, noise), entries),
          ),
        ).toBe(entry.value);
      }),
      propertyConfig({ numRuns: 300 }),
    );
  });

  test("every alias reads as its entry's value through the same noise", () => {
    fc.assert(
      fc.property(
        aliasedVocabularyArb,
        fc.nat(),
        noiseArb,
        (entries, pick, noise) => {
          const entry = entries[pick % entries.length];
          const alias = entry?.aliases?.[0];
          fc.pre(entry !== undefined && alias !== undefined);
          expect(
            valueOf(normalizeVocabularyValue(withNoise(alias, noise), entries)),
          ).toBe(entry.value);
        },
      ),
      propertyConfig({ numRuns: 300 }),
    );
  });

  test("a value with words added reads as it when no other entry fits inside", () => {
    fc.assert(
      fc.property(
        vocabularyArb,
        fc.nat(),
        fc.array(wordArb, { minLength: 1, maxLength: 3 }),
        (entries, pick, extra) => {
          const entry = entries[pick % entries.length];
          fc.pre(entry !== undefined);
          const input = `${entry.value} ${extra.join(" ")}`;
          const inputTokens = new Set(tokens(input));
          fc.pre(
            entries.every(
              (other) =>
                other === entry ||
                !tokens(other.value).every((token) => inputTokens.has(token)),
            ),
          );
          expect(valueOf(normalizeVocabularyValue(input, entries))).toBe(
            entry.value,
          );
        },
      ),
      propertyConfig({ numRuns: 300 }),
    );
  });

  test("a placeholder is no value whatever the vocabulary holds", () => {
    fc.assert(
      fc.property(
        vocabularyArb,
        fc.constantFrom(...ABSENT_PLACEHOLDERS),
        (entries, placeholder) => {
          expect(normalizeVocabularyValue(placeholder, entries).ok).toBe(
            "absent",
          );
        },
      ),
      propertyConfig({ numRuns: 100 }),
    );
  });
});
