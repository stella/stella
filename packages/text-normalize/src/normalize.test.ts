import { describe, expect, test } from "bun:test";

import { normalizeSearchText } from "./normalize.js";

// Each group lists spellings a user might type for the same word. After
// normalization they must all collapse to a single search key.
const EQUIVALENCE_GROUPS: readonly (readonly string[])[] = [
  ["أحمد", "احمد"], // alef-hamza-above vs bare alef
  ["إسلام", "اسلام"], // alef-hamza-below vs bare alef
  ["آمنة", "امنه"], // alef-madda + teh-marbuta
  ["خدمة", "خدمه"], // teh marbuta -> heh
  ["يكفى", "يكفي"], // alef maksura -> yeh
  ["مُحَمَّد", "محمد"], // tashkeel stripped
  ["مـحـمـد", "محمد"], // tatweel removed
  ["مؤمن", "مومن"], // waw hamza -> waw
  ["مسئول", "مسيول"], // yeh hamza -> yeh
  ["٢٠٢٤", "2024"], // Arabic-Indic digits
  ["۲۰۲۴", "2024"], // Extended Arabic-Indic digits
];

// Exact outputs pin the contract the SQL arabic_normalize() must
// reproduce byte-for-byte.
const GOLDEN: readonly (readonly [string, string])[] = [
  ["أحمد", "احمد"],
  ["خدمة", "خدمه"],
  ["يكفى", "يكفي"],
  ["مُحَمَّد", "محمد"],
  ["مـحـمـد", "محمد"],
  ["مؤمن", "مومن"],
  ["مسئول", "مسيول"],
  ["ء", ""], // standalone hamza dropped
  ["٢٠٢٤", "2024"],
  ["HELLO Wörld", "hello wörld"], // Latin: NFKC + ASCII case folding
  ["IBRAHIM İBRAHIM", "ibrahim ibrahim"], // locale-stable I folding
  ["  a   b  ", "a b"], // whitespace collapsed and trimmed
  ["a\tb\nc", "a b c"], // ASCII controls collapsed
  ["a\u00a0b", "a b"], // NBSP collapsed
  ["a\u2007b\u3000c", "a b c"], // Unicode space separators collapsed
];

describe("normalizeSearchText", () => {
  test("each equivalence group collapses to one key", () => {
    for (const group of EQUIVALENCE_GROUPS) {
      const keys = new Set(group.map(normalizeSearchText));
      expect(keys.size).toBe(1);
    }
  });

  test.each(GOLDEN)("normalize(%p) === %p", (input, expected) => {
    expect(normalizeSearchText(input)).toBe(expected);
  });

  test("is idempotent", () => {
    const samples = [
      ...EQUIVALENCE_GROUPS.flat(),
      "السلام عليكم",
      "Hello World",
    ];
    for (const sample of samples) {
      const once = normalizeSearchText(sample);
      expect(normalizeSearchText(once)).toBe(once);
    }
  });

  test("leaves fold targets (bare alef, waw, yeh, heh) stable", () => {
    expect(normalizeSearchText("اويه")).toBe("اويه");
  });
});
