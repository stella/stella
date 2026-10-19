import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { extractWords, validateAst } from "./validate-ast";

const REFERENCE_SKIP_WORDS = new Set([
  "[obrázek]",
  "obrázek",
  "česká",
  "republika",
  "jménem",
  "republiky",
  "pokračování",
]);
const REFERENCE_LETTER = /\p{L}/u;
const referenceTrimNonLetters = (word: string): string => {
  let start = 0;
  let end = word.length;
  while (start < end && !REFERENCE_LETTER.test(word.charAt(start))) {
    start += 1;
  }
  while (end > start && !REFERENCE_LETTER.test(word.charAt(end - 1))) {
    end -= 1;
  }
  return word.slice(start, end);
};
const referenceSeparateSkipMarkers = (text: string): string => {
  let separated = "";
  let index = 0;
  while (index < text.length) {
    const open = text.indexOf("[", index);
    const close = open === -1 ? -1 : text.indexOf("]", open + 1);
    if (close === -1) {
      return separated + text.slice(index);
    }
    const marker = referenceTrimNonLetters(
      text.slice(open + 1, close).toLowerCase(),
    );
    separated +=
      text.slice(index, open) +
      (REFERENCE_SKIP_WORDS.has(marker) ? " " : text.slice(open, close + 1));
    index = close + 1;
  }
  return separated;
};

// The implementation immediately before the parsed-document optimization.
const referenceExtractWords = (text: string): Set<string> => {
  const words = new Set<string>();
  for (const w of referenceSeparateSkipMarkers(text).split(/\s+/u)) {
    const noBrackets = w.replace(/[[\]]/gu, "");
    const clean = referenceTrimNonLetters(noBrackets.toLowerCase());
    if (
      clean.length >= 3 &&
      !/^\d+$/u.test(clean) &&
      !REFERENCE_SKIP_WORDS.has(clean) &&
      !/^\[\d+\]$/u.test(w.toLowerCase())
    ) {
      words.add(clean);
    }
  }
  return words;
};

test("anonymization brackets preserve Greek final sigma during validation", () => {
  expect(extractWords("ΛΟΓΟ[Σ]")).toEqual(extractWords("ΛΟΓΟΣ"));

  const result = validateAst("<p>ΛΟΓΟ[Σ]</p>", [
    {
      type: "paragraph",
      anchorId: "greek-word",
      inlines: [{ type: "text", text: "ΛΟΓΟΣ" }],
      plainText: "ΛΟΓΟΣ",
    },
  ]);

  expect(result.stats.missingWords).toEqual([]);
  expect(result.issues.some(({ code }) => code === "MISSING_WORDS")).toBe(
    false,
  );
});

const LETTERS = [
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
  ..."ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩαβγδεζηθικλμνξοπρσςτυφχψω",
  ..."АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЫЭЮЯабвгдежзийклмнопрстуфхцчшщыэюя",
  "İ",
  "I",
  "i",
  "ı",
] as const;

const bracketedWord = fc
  .tuple(
    fc.array(fc.constantFrom(...LETTERS), { minLength: 3, maxLength: 24 }),
    fc.array(fc.nat(), { minLength: 1, maxLength: 12 }),
  )
  .map(([letters, positions]) => {
    const bracketed = new Set(
      positions.map((position) => position % letters.length),
    );
    return letters
      .map((letter, index) => (bracketed.has(index) ? `[${letter}]` : letter))
      .join("");
  });

test("bracketed multilingual words retain pre-optimization normalization", () => {
  assertProperty(
    "bracketed multilingual words retain pre-optimization normalization",
    fc.property(
      fc.array(bracketedWord, { minLength: 1, maxLength: 12 }),
      (words) => {
        const text = words.join(" ");
        expect(extractWords(text)).toEqual(referenceExtractWords(text));
      },
    ),
  );
});
