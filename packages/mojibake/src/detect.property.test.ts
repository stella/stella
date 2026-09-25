/**
 * The detector over the whole class: text in each language, written in each
 * charset that can hold it and read as each one that cannot be right.
 *
 * Two properties, for real sentences and for generated text alike:
 *
 * - a repair the detector proposes never writes a wrong word: each word is
 *   restored or left as it was read, and when exemplar letters cannot tell
 *   two pairs apart the finding names the alternatives. Real sentences are
 *   restored exactly;
 * - text that was never mis-decoded is never flagged.
 *
 * And a detection floor: when mis-decoding turns at least two distinct words,
 * three times in all, into ones the language does not write (a letter
 * outside its CLDR main exemplars, or a control character), the text is
 * reported and repaired. Less is what one foreign name looks like, and is
 * below what the detector claims to find.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig, propertySeed } from "@stll/property-testing";

import { alphabetFor } from "./alphabet.js";
import { DECODING_PAIRS, type DecodingPair, misdecode } from "./charsets.js";
import {
  checkTextEncoding,
  type EncodingCheck,
  repairMisdecoding,
} from "./detect.js";
import { CLDR_EXEMPLARS } from "./exemplars.generated.js";
import { UDHR_ARTICLE_1, type UdhrLanguage } from "./udhr-article-1.fixture.js";

const config = (numRuns: number) =>
  propertyConfig({ numRuns, seed: propertySeed() });

const LANGUAGES = Object.keys(UDHR_ARTICLE_1).filter(
  (language): language is UdhrLanguage =>
    Object.hasOwn(UDHR_ARTICLE_1, language),
);

const words = (text: string): string[] => text.split(/[\t\n\r ]+/u);

type BrokenWords = { distinct: number; occurrences: number };

/** Words the mis-decoding made unwritable in the language. */
const brokenWords = (
  original: string,
  misread: string,
  language: string,
): BrokenWords => {
  const alphabet = alphabetFor(language);
  if (alphabet === null) {
    throw new Error(`CLDR has exemplars for ${language}`);
  }
  const before = words(original);
  const broken = new Set<string>();
  let occurrences = 0;
  for (const [index, word] of words(misread).entries()) {
    if (word === before[index]) {
      continue;
    }
    const foreign = Array.from(word).some((char) => {
      const cp = char.codePointAt(0) ?? 0;
      return (
        (cp >= 0x80 && cp <= 0x9f) ||
        (/\p{L}/u.test(char) && !alphabet.native.has(cp))
      );
    });
    if (foreign) {
      broken.add(word);
      occurrences += 1;
    }
  }
  return { distinct: broken.size, occurrences };
};

type RoundTripCase = {
  language: string;
  original: string;
  pair: DecodingPair;
  /** Real text is restored exactly; generated text may leave a word undecided. */
  exact: boolean;
};

const assertRoundTrip = ({
  language,
  original,
  pair,
  exact,
}: RoundTripCase): void => {
  const misread = misdecode(original, pair);
  if (misread === null || misread === original) {
    return;
  }
  const check: EncodingCheck = checkTextEncoding(misread, language);
  const finding =
    check.status === "suspect"
      ? check.findings.find((candidate) => candidate.kind === "misdecoded")
      : undefined;
  if (finding?.kind === "misdecoded") {
    const repaired = repairMisdecoding(misread, {
      language,
      pair: finding.pair,
      layers: finding.layers,
    });
    if (exact && finding.alternatives.length === 0) {
      expect(repaired).toBe(original);
    }
    if (finding.alternatives.length === 0) {
      const before = words(original);
      const read = words(misread);
      for (const [index, word] of words(repaired).entries()) {
        expect([before[index], read[index]]).toContain(word);
      }
    }
  }
  const broken = brokenWords(original, misread, language);
  if (broken.distinct >= 2 && broken.occurrences >= 3) {
    expect(finding?.kind).toBe("misdecoded");
  }
};

describe("real sentences", () => {
  // The sentence three times, as a paragraph of a longer document would
  // repeat its words.
  const document = (language: UdhrLanguage): string =>
    Array.from({ length: 3 }, () => UDHR_ARTICLE_1[language]).join("\n");

  test.each(LANGUAGES)(
    "%s mis-read through any pair round-trips",
    (language) => {
      for (const pair of DECODING_PAIRS) {
        assertRoundTrip({
          language,
          original: document(language),
          pair,
          exact: true,
        });
      }
    },
  );

  test.each(LANGUAGES)("%s read correctly is clean", (language) => {
    expect(checkTextEncoding(document(language), language)).toEqual({
      status: "clean",
    });
  });

  test("detection is not vacuous: UTF-8 read as Latin-1 is found and repaired unambiguously", () => {
    const common: DecodingPair[] = [
      { actual: "utf-8", assumed: "windows-1252" },
      { actual: "utf-8", assumed: "iso-8859-1" },
    ];
    for (const language of LANGUAGES) {
      for (const pair of common) {
        const misread = misdecode(document(language), pair) ?? "";
        expect(misread).not.toBe(document(language));
        if (brokenWords(document(language), misread, language).distinct < 2) {
          // Slovenian: one word outside ASCII, below the floor.
          continue;
        }
        const check = checkTextEncoding(misread, language);
        const finding =
          check.status === "suspect"
            ? check.findings.find(
                (candidate) => candidate.kind === "misdecoded",
              )
            : undefined;
        expect(
          finding?.kind === "misdecoded" ? finding.alternatives : null,
        ).toEqual([]);
      }
    }
  });
});

/** Words spelled from the language's own CLDR main exemplar letters. */
const exemplarText = (language: UdhrLanguage) => {
  const letters = Array.from(CLDR_EXEMPLARS[language].main).filter((char) =>
    /\p{L}/u.test(char),
  );
  // Some words in capitals, as headings and party names are: capitals are
  // where two letters most often spell a valid UTF-8 sequence by accident.
  const word = fc
    .tuple(
      fc.array(fc.constantFrom(...letters), { minLength: 2, maxLength: 9 }),
      fc.boolean(),
    )
    .map(([chars, capitals]) =>
      capitals ? chars.join("").toUpperCase() : chars.join(""),
    );
  return fc
    .array(word, { minLength: 20, maxLength: 80 })
    .map((generated) => generated.join(" "));
};

describe("every pair of a language's own letters", () => {
  // Exhaustive rather than sampled: two letters a language writes side by
  // side can be the bytes of a UTF-8 sequence read as windows-1252 (Czech
  // "ÍŠ" is CD 8A), and a sampler rarely draws the pair that is.
  test.each(LANGUAGES)("%s, lower and upper case, is clean", (language) => {
    const letters = Array.from(CLDR_EXEMPLARS[language].main).filter((char) =>
      /\p{L}/u.test(char),
    );
    const cased = [
      ...letters,
      ...letters.map((char) => char.toUpperCase()),
    ].filter((char) => Array.from(char).length === 1);
    const pairs = cased.flatMap((first) =>
      cased.map((second) => `a${first}${second}a`),
    );
    const text = [UDHR_ARTICLE_1[language], ...pairs, ...pairs].join(" ");
    expect(checkTextEncoding(text, language)).toEqual({ status: "clean" });
  });
});

describe("generated text", () => {
  test("a repair the detector proposes never writes a wrong word", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...LANGUAGES).chain((language) =>
          fc.record({
            language: fc.constant(language),
            original: exemplarText(language),
            pair: fc.constantFrom(...DECODING_PAIRS),
          }),
        ),
        (roundTrip) => {
          assertRoundTrip({ ...roundTrip, exact: false });
        },
      ),
      config(300),
    );
  });

  test("text in the language's own letters, symbols standing apart and one foreign name is clean", () => {
    const symbols = [
      "¾",
      "½",
      "¹",
      "²",
      "°",
      "§",
      "±",
      "×",
      "€",
      "–",
      "„",
      "“",
      "«",
      "»",
    ];
    const foreign = [
      "Søren",
      "Straße",
      "Dvořák",
      "Łódź",
      "Müller",
      "Œuvre",
      "Kőrösi",
    ];
    fc.assert(
      fc.property(
        fc.constantFrom(...LANGUAGES).chain((language) =>
          fc.record({
            language: fc.constant(language),
            text: exemplarText(language),
            symbols: fc.array(fc.constantFrom(...symbols), { maxLength: 6 }),
            name: fc.constantFrom(...foreign),
            repeats: fc.integer({ min: 0, max: 5 }),
          }),
        ),
        ({ language, text, symbols: standalone, name, repeats }) => {
          const document = [
            text,
            ...standalone,
            ...Array.from({ length: repeats }, () => name),
          ].join(" ");
          expect(checkTextEncoding(document, language)).toEqual({
            status: "clean",
          });
        },
      ),
      config(300),
    );
  });
});
