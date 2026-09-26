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
 * And a detection floor: when mis-decoding turns at least three distinct
 * words (told apart by their letters, not their punctuation) into ones the
 * language does not write (a letter outside its CLDR main exemplars, or a
 * control character), the text is reported and repaired. Less is what two
 * foreign names look like, and is below what the detector claims to find
 * from letters alone; garbled words need fewer (`detect.test.ts`).
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  propertyConfig,
  propertySeed,
  propertyTestTimeout,
} from "@stll/property-testing";

import { alphabetFor } from "./alphabet.js";
import {
  DECODING_PAIRS,
  type DecodingPair,
  misdecode,
  undoMisdecoding,
} from "./charsets.js";
import {
  checkTextEncoding,
  CODE_UNIT_BUDGET,
  type EncodingCheck,
  type EncodingCheckCounters,
  MAX_EXAMINED_WORDS,
  MAX_WORD_CODE_UNITS,
  PAIR_EVALUATION_BUDGET,
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
      broken.add(
        Array.from(word)
          .filter((char) => /[\p{L}\p{M}]/u.test(char))
          .join(""),
      );
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
  if (broken.distinct >= 3) {
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
        if (brokenWords(document(language), misread, language).distinct < 3) {
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
  const PAIRS_PER_TEXT = 150;
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
    const isUpper = (char: string): boolean => /\p{Lu}/u.test(char);
    // Each pair inside a word cased as a writer cases one: all lower, all
    // capitals, or a capital first. A capital after a lowercase letter is
    // what the detector reads as a misread byte, so no writer's word has one.
    const pairs = cased.flatMap((first) =>
      cased
        .filter((second) => isUpper(first) || !isUpper(second))
        .map(
          (second) =>
            `${isUpper(first) ? "A" : "a"}${first}${second}${isUpper(second) ? "A" : "a"}`,
        ),
    );
    // In texts short enough to be weighed whole: a longer one would stop at
    // the detector's bounds and prove nothing.
    for (let start = 0; start < pairs.length; start += PAIRS_PER_TEXT) {
      const chunk = pairs.slice(start, start + PAIRS_PER_TEXT);
      const text = [UDHR_ARTICLE_1[language], ...chunk, ...chunk].join(" ");
      expect(checkTextEncoding(text, language)).toEqual({ status: "clean" });
    }
  });
});

describe("typographic punctuation in otherwise ASCII text", () => {
  // The marks an English decision carries outside ASCII: apostrophes and
  // quotation marks, dashes, an ellipsis, signs.
  const MARKS = [
    "’",
    "‘",
    "“",
    "”",
    "–",
    "—",
    "…",
    "€",
    "™",
    "§",
    "°",
    "«",
    "»",
  ];
  const text = fc
    .array(
      fc.tuple(
        fc.stringMatching(/^[A-Za-z]{1,9}$/u),
        fc.option(fc.constantFrom(...MARKS), { freq: 3 }),
      ),
      { minLength: 5, maxLength: 60 },
    )
    .map((marked) =>
      marked.map(([word, mark]) => (mark === null ? word : `${word}${mark}`)),
    )
    .filter(
      (marked) =>
        marked.filter((word) => /[^\p{ASCII}]/u.test(word)).length >= 2,
    )
    .map((marked) => marked.join(" "));
  // Section signs standing apart and units against numbers or capitals,
  // with no lowercase word anywhere: statute references, measurements.
  const signs = fc
    .array(
      fc.oneof(
        fc.constantFrom("§", "§§"),
        fc
          .tuple(
            fc.stringMatching(/^(?:\d{1,3}|[A-Z]{1,4})$/u),
            fc.constantFrom("°C", "°F", "°", "²", "³", "‰"),
          )
          .map(([base, unit]) => `${base}${unit}`),
        fc.stringMatching(/^(?:\d{1,3}|[A-Z]{1,6})$/u),
      ),
      { minLength: 2, maxLength: 40 },
    )
    .filter(
      (tokens) =>
        tokens.filter((token) => /[^\p{ASCII}]/u.test(token)).length >= 2,
    )
    .map((tokens) => tokens.join(" "));
  const TEXTS = [
    ["words with marks", text],
    ["signs and units without lowercase", signs],
  ] as const;

  test.each(TEXTS)("%s, read correctly, is clean", (_, texts) => {
    fc.assert(
      fc.property(texts, (written) => {
        expect(checkTextEncoding(written, "en")).toEqual({ status: "clean" });
      }),
      config(300),
    );
  });

  test.each(TEXTS)(
    "%s, written in UTF-8 and read as windows-1252 or Latin-1, is reported",
    (_, texts) => {
      fc.assert(
        fc.property(
          texts,
          fc.constantFrom<DecodingPair>(
            { actual: "utf-8", assumed: "windows-1252" },
            { actual: "utf-8", assumed: "iso-8859-1" },
          ),
          (written, pair) => {
            const misread = misdecode(written, pair);
            expect(misread).not.toBeNull();
            expect(misread).not.toBe(written);
            expect(checkTextEncoding(misread ?? "", "en").status).toBe(
              "suspect",
            );
          },
        ),
        config(300),
      );
    },
  );
});

describe("a native capital before a mark", () => {
  const UTF8_READ_AS_WINDOWS_1252 = {
    actual: "utf-8",
    assumed: "windows-1252",
  } as const satisfies DecodingPair;
  /** Spaces that bind a letter to the word after it, inside one token. */
  const NONBREAKING_SPACES = ["\u00A0", "\u2007", "\u202F"];
  /** Marks a writer sets after a capital: footnotes, degrees, spacing, quotes. */
  const MARKS = [" ", "¹", "²", "³", "°", "«", "»"];
  const lettersOf = (tag: keyof typeof CLDR_EXEMPLARS): string[] =>
    Array.from(CLDR_EXEMPLARS[tag].main).filter((char) => /\p{L}/u.test(char));
  const capitalsOf = (tag: keyof typeof CLDR_EXEMPLARS): string[] =>
    lettersOf(tag)
      .map((char) => char.toUpperCase())
      .filter(
        (char) => Array.from(char).length === 1 && /[^\p{ASCII}]/u.test(char),
      );
  /**
   * Every language CLDR has exemplars for, with each capital it writes that
   * spells a UTF-8 punctuation mark with a mark after it ("Â¹" is C2 B9,
   * "¹"): French, Romanian, Portuguese, Vietnamese and every other language
   * whose letters include one.
   */
  const AMBIGUOUS = Object.keys(CLDR_EXEMPLARS)
    .filter((tag): tag is keyof typeof CLDR_EXEMPLARS =>
      Object.hasOwn(CLDR_EXEMPLARS, tag),
    )
    .flatMap((tag) => {
      const sequences = capitalsOf(tag).flatMap((capital) =>
        MARKS.map((mark) => `${capital}${mark}`).filter((sequence) => {
          const restored = undoMisdecoding(sequence, UTF8_READ_AS_WINDOWS_1252);
          return (
            restored !== null &&
            Array.from(restored).length === 1 &&
            /^[\p{P}\p{S}\p{Z}\p{No}]$/u.test(restored)
          );
        }),
      );
      return sequences.length === 0 ? [] : [{ tag, sequences }];
    });

  test("the languages are derived, not listed", () => {
    expect(AMBIGUOUS.map(({ tag }) => tag)).toEqual(
      expect.arrayContaining(["fr", "ro", "pt", "vi"]),
    );
    expect(AMBIGUOUS.map(({ tag }) => tag)).not.toContain("cs");
    expect(AMBIGUOUS.map(({ tag }) => tag)).not.toContain("en");
  });

  test("in a language that writes the capital, text is clean", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...AMBIGUOUS).chain(({ tag, sequences }) => {
          const lower = lettersOf(tag).filter((char) => /\p{Ll}/u.test(char));
          const word = fc
            .array(fc.constantFrom(...lower), { minLength: 1, maxLength: 9 })
            .map((chars) => chars.join(""));
          // "Â¹", "Â¹,", "ĂÂ²", « Â » with nonbreaking spaces inside.
          const marked = fc
            .tuple(
              fc.array(fc.constantFrom(...capitalsOf(tag)), { maxLength: 2 }),
              fc.constantFrom(...sequences),
              fc.constantFrom("", ",", ".", ";"),
            )
            .map(
              ([capitals, sequence, after]) =>
                `${capitals.join("")}${sequence}${after}`,
            );
          const quoted = fc
            .constantFrom(...capitalsOf(tag))
            .map((capital) => `« ${capital} »`);
          // "La lettre Â\u00A0est": a capital bound to the lowercase word
          // after it. Where the capital and U+00A0 spell a UTF-8 sequence
          // ("Â\u00A0" is C2 A0), the word must not vouch for it; it is
          // drawn in ASCII letters too, which never stop the read-back.
          const ascii = lower.filter((char) => /^[a-z]$/u.test(char));
          const after =
            ascii.length === 0
              ? word
              : fc.oneof(
                  word,
                  fc
                    .array(fc.constantFrom(...ascii), {
                      minLength: 1,
                      maxLength: 9,
                    })
                    .map((chars) => chars.join("")),
                );
          const binding = fc
            .tuple(
              fc.constantFrom(...capitalsOf(tag)),
              fc.constantFrom(...NONBREAKING_SPACES),
            )
            .map(([capital, space]) => `${capital}${space}`);
          const bindingSequences = sequences.filter((sequence) =>
            sequence.endsWith("\u00A0"),
          );
          const bound = fc
            .tuple(
              bindingSequences.length === 0
                ? binding
                : fc.oneof(binding, fc.constantFrom(...bindingSequences)),
              after,
            )
            .map(([binder, lowercase]) => `${binder}${lowercase}`);
          const token = fc.oneof(word, word, marked, quoted, bound);
          return fc.record({
            tag: fc.constant(tag),
            first: token,
            rest: fc.array(
              fc.tuple(fc.constantFrom(" ", ...NONBREAKING_SPACES), token),
              { minLength: 1, maxLength: 40 },
            ),
          });
        }),
        ({ tag, first, rest }) => {
          const text = [first, ...rest.flat()].join("");
          expect(checkTextEncoding(text, tag)).toEqual({ status: "clean" });
        },
      ),
      config(300),
    );
  });

  /**
   * Every language with a lowercase letter whose UTF-8 bytes read as
   * windows-1252 end in U+00A0 ("à" is C3 A0, "Ã\u00A0"): there the
   * nonbreaking space is inside the word, not a space binding two.
   */
  const CONTINUED_BY_NBSP = Object.keys(CLDR_EXEMPLARS)
    .filter((tag): tag is keyof typeof CLDR_EXEMPLARS =>
      Object.hasOwn(CLDR_EXEMPLARS, tag),
    )
    .flatMap((tag) => {
      const letters = lettersOf(tag).filter(
        (char) =>
          /\p{Ll}/u.test(char) &&
          misdecode(char, UTF8_READ_AS_WINDOWS_1252)?.endsWith(" "),
      );
      // An ASCII letter survives the read in lowercase; without one the word
      // read back is capitals and marks, which alone sign nothing.
      const ascii = lettersOf(tag).filter((char) => /^[a-z]$/u.test(char));
      return letters.length === 0 || ascii.length === 0
        ? []
        : [{ tag, letters, ascii }];
    });

  test("the languages whose letters read as a nonbreaking space are derived", () => {
    expect(CONTINUED_BY_NBSP.map(({ tag }) => tag)).toEqual(
      expect.arrayContaining(["pt", "fr", "it"]),
    );
  });

  test("a word whose letter reads as a nonbreaking space is found", () => {
    fc.assert(
      fc.property(
        fc
          .constantFrom(...CONTINUED_BY_NBSP)
          .chain(({ tag, letters, ascii }) => {
            const around = fc
              .array(fc.constantFrom(...ascii), { maxLength: 6 })
              .map((chars) => chars.join(""));
            return fc.record({
              tag: fc.constant(tag),
              word: fc
                .tuple(around, fc.constantFrom(...letters), around)
                .filter(([before, , after]) => `${before}${after}`.length > 0)
                .map(([before, letter, after]) => `${before}${letter}${after}`),
            });
          }),
        ({ tag, word }) => {
          const read = misdecode(word, UTF8_READ_AS_WINDOWS_1252) ?? "";
          expect(checkTextEncoding(`${read} ${read}`, tag).status).toBe(
            "suspect",
          );
        },
      ),
      config(300),
    );
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

  test("text in the language's own letters, symbols apart or attached as notation, and two foreign names however punctuated is clean", () => {
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
    /** Written against a word's edge: exponents, footnote marks, degrees. */
    const notation = ["¹", "²", "³", "°", "⁴", "⁵"];
    const foreign = [
      "Søren",
      "Straße",
      "Dvořák",
      "Łódź",
      "Müller",
      "Œuvre",
      "Kőrösi",
    ];
    /** How a name is set in running text. */
    const punctuated = [
      (name: string) => name,
      (name: string) => `${name},`,
      (name: string) => `${name}.`,
      (name: string) => `(${name})`,
      (name: string) => `„${name}“`,
      (name: string) => `«${name}»`,
    ];
    fc.assert(
      fc.property(
        fc.constantFrom(...LANGUAGES).chain((language) =>
          fc.record({
            language: fc.constant(language),
            text: exemplarText(language),
            symbols: fc.array(fc.constantFrom(...symbols), { maxLength: 6 }),
            marks: fc.array(fc.constantFrom(...notation), { maxLength: 6 }),
            names: fc.uniqueArray(fc.constantFrom(...foreign), {
              maxLength: 2,
            }),
            settings: fc.array(fc.constantFrom(...punctuated), {
              maxLength: 6,
            }),
          }),
        ),
        ({ language, text, symbols: standalone, marks, names, settings }) => {
          const noted = text.split(" ").map((word, index) => {
            const mark = marks[index];
            return mark === undefined ? word : `${word}${mark}`;
          });
          const mentions = names.flatMap((name) =>
            settings.map((setting) => setting(name)),
          );
          const document = [...noted, ...standalone, ...mentions].join(" ");
          expect(checkTextEncoding(document, language)).toEqual({
            status: "clean",
          });
        },
      ),
      config(300),
    );
  });
});

describe("bounded work", () => {
  /** Latin letters spelling `index`, so every generated word is distinct. */
  const spelled = (index: number): string => {
    let rest = index;
    let word = "";
    do {
      word += String.fromCodePoint(0x61 + (rest % 26));
      rest = Math.floor(rest / 26);
    } while (rest > 0);
    return word;
  };
  // Alternating misfit ("Sø…", a letter no CLDR Czech exemplar holds) and
  // native ("př…") words: the shape that reaches the costliest branch of
  // pair evidence, scanning the native words once a pair's misfits pass the
  // evidence threshold (`detect.test.ts` covers it at a fixed size).
  const mixedText = (wordCount: number): string =>
    Array.from({ length: wordCount }, (_, index) =>
      index % 2 === 0 ? `Sø${spelled(index)}` : `př${spelled(index)}`,
    ).join(" ");

  /**
   * Adversarial shapes, each `length` code units long: runs of one character
   * class before, inside and after a word's non-ASCII character, classes
   * alternating, and the signatures repeated. A scan that restarts a run from
   * every position (an unanchored `[…]*$`, say) is quadratic in exactly
   * these.
   */
  const SHAPES = [
    [
      "punctuation before a final non-ASCII letter",
      (length: number) => `${".".repeat(length)}ø`,
    ],
    [
      "punctuation inside a token",
      (length: number) => `a${".".repeat(length)}ø`,
    ],
    [
      "punctuation after a non-ASCII letter",
      (length: number) => `ø${".".repeat(length)}`,
    ],
    [
      "digits before a final non-ASCII letter",
      (length: number) => `${"1".repeat(length)}ø`,
    ],
    [
      "whitespace before a final non-ASCII letter",
      (length: number) => `${" \t\n".repeat(length / 3)}ø`,
    ],
    [
      "letters before a final non-ASCII letter",
      (length: number) => `${"a".repeat(length)}ø`,
    ],
    [
      "letters and punctuation alternating",
      (length: number) => `${"a.".repeat(length / 2)}ø`,
    ],
    [
      "punctuation and non-ASCII letters alternating",
      (length: number) => ".ø".repeat(length / 2),
    ],
    ["short punctuated words", (length: number) => "(ø). ".repeat(length / 5)],
    [
      "combining marks in one word",
      (length: number) => `a${"\u0301\u0316".repeat(length / 2)}`,
    ],
    [
      "replacement characters and C1 controls",
      (length: number) => "\ufffd\u0085".repeat(length / 2),
    ],
    ["UTF-8 signatures", (length: number) => "Â§ ".repeat(length / 3)],
  ] as const;

  test(
    "work grows linearly with the text, whatever its shape",
    () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...SHAPES),
          fc.oneof(
            fc.integer({ min: 0, max: 2_000_000 }),
            fc.constant(2_000_000),
          ),
          ([, shape], length) => {
            const text = shape(length);
            const counters: EncodingCheckCounters = {
              wordsExamined: 0,
              pairEvaluations: 0,
              codeUnits: 0,
              scannedCodeUnits: 0,
            };
            checkTextEncoding(text, "cs", { counters });
            // Splitting, trimming and choosing the most frequent words read
            // each code unit a bounded number of times; everything past them
            // is within the budgets.
            expect(counters.scannedCodeUnits).toBeLessThanOrEqual(
              4 * text.length,
            );
            expect(counters.codeUnits).toBeLessThanOrEqual(CODE_UNIT_BUDGET);
            expect(counters.pairEvaluations).toBeLessThanOrEqual(
              PAIR_EVALUATION_BUDGET,
            );
            expect(counters.wordsExamined).toBeLessThanOrEqual(
              MAX_EXAMINED_WORDS,
            );
          },
        ),
        config(24),
      );
    },
    propertyTestTimeout(30_000),
  );

  test(
    "distinct words examined and pair evaluations never exceed the documented bounds, at every size",
    () => {
      fc.assert(
        fc.property(fc.integer({ min: 0, max: 30_000 }), (wordCount) => {
          const counters: EncodingCheckCounters = {
            wordsExamined: 0,
            pairEvaluations: 0,
            codeUnits: 0,
            scannedCodeUnits: 0,
          };
          const text = mixedText(wordCount);
          checkTextEncoding(text, "cs", { counters });
          // Past the distinct-word bound the most frequent are chosen, in
          // passes over the words rather than by sorting them.
          expect(counters.scannedCodeUnits).toBeLessThanOrEqual(
            4 * text.length,
          );
          expect(counters.wordsExamined).toBeLessThanOrEqual(
            MAX_EXAMINED_WORDS,
          );
          expect(counters.pairEvaluations).toBeLessThanOrEqual(
            PAIR_EVALUATION_BUDGET,
          );
          expect(counters.codeUnits).toBeLessThanOrEqual(CODE_UNIT_BUDGET);
        }),
        config(30),
      );
    },
    propertyTestTimeout(20_000),
  );

  test(
    "characters classified and read back never exceed the code-unit budget, however long the words",
    () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 40 }),
          fc.integer({ min: 0, max: 500_000 }),
          (count, total) => {
            // Words in letters Czech does not write, read back through every
            // pair: the costliest word there is, grown in length and number.
            const padding = Math.floor(total / count);
            const tokens = Array.from(
              { length: count },
              (_, index) => `Sø${spelled(index)}${"a".repeat(padding)}`,
            );
            const counters: EncodingCheckCounters = {
              wordsExamined: 0,
              pairEvaluations: 0,
              codeUnits: 0,
              scannedCodeUnits: 0,
            };
            const check = checkTextEncoding(tokens.join(" "), "cs", {
              counters,
            });
            expect(counters.codeUnits).toBeLessThanOrEqual(CODE_UNIT_BUDGET);
            expect(counters.pairEvaluations).toBeLessThanOrEqual(
              PAIR_EVALUATION_BUDGET,
            );
            if (tokens.some((token) => token.length > MAX_WORD_CODE_UNITS)) {
              expect(check.status).not.toBe("clean");
            }
          },
        ),
        config(30),
      );
    },
    propertyTestTimeout(20_000),
  );

  test(
    "past the distinct-word bound, the most frequent words are the ones weighed",
    () => {
      fc.assert(
        fc.property(
          fc.integer({
            min: MAX_EXAMINED_WORDS + 1,
            max: MAX_EXAMINED_WORDS + 10_000,
          }),
          fc.nat(),
          (wordCount, seed) => {
            // Native words once each, and "Â§" (C2 A7, "§", which Czech
            // never writes as "Â") twice, wherever it lands: the first
            // words the text uses would miss it, the most frequent do not.
            const at = seed % (wordCount + 1);
            const tokens = Array.from(
              { length: wordCount },
              (_, index) => `př${spelled(index)}`,
            );
            tokens.splice(at, 0, "Â§", "Â§");
            const counters: EncodingCheckCounters = {
              wordsExamined: 0,
              pairEvaluations: 0,
              codeUnits: 0,
              scannedCodeUnits: 0,
            };
            const text = tokens.join(" ");
            const check = checkTextEncoding(text, "cs", { counters });
            expect(counters.wordsExamined).toBe(MAX_EXAMINED_WORDS);
            expect(
              check.status === "suspect"
                ? check.findings.map(({ kind }) => kind)
                : check,
            ).toEqual(["utf8-read-as-single-byte"]);
          },
        ),
        config(30),
      );
    },
    propertyTestTimeout(15_000),
  );

  test(
    "a distinct-word count past the bound is never called clean",
    () => {
      fc.assert(
        fc.property(
          fc.integer({
            min: MAX_EXAMINED_WORDS + 1,
            max: MAX_EXAMINED_WORDS + 10_000,
          }),
          (wordCount) => {
            // Every word is native: no misfit ever exists to be found as
            // evidence, so the only bound this text can reach is the number
            // of distinct words, and the only honest verdict past it is
            // "incomplete", never "clean".
            const text = Array.from(
              { length: wordCount },
              (_, index) => `př${spelled(index)}`,
            ).join(" ");
            const counters: EncodingCheckCounters = {
              wordsExamined: 0,
              pairEvaluations: 0,
              codeUnits: 0,
              scannedCodeUnits: 0,
            };
            const check = checkTextEncoding(text, "cs", { counters });
            expect(counters.wordsExamined).toBe(MAX_EXAMINED_WORDS);
            expect(check).toEqual({
              status: "incomplete",
              limit: "distinct-words",
            });
          },
        ),
        config(30),
      );
    },
    propertyTestTimeout(15_000),
  );
});
