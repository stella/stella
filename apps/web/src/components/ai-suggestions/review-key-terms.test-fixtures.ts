import { escapeRegExp } from "@stll/text-normalize";

export const PHRASE_RANGE_CASES = [
  ["😀 ČAPKOVĚ\n návrhu", "čapkově návrhu", [[3, 18]]],
  ["[a+b] [aab]", "[a+b]", [[0, 5]]],
  ["a a a", "a a", [[0, 3]]],
  ["a\uFEFFb", "a b", [[0, 3]]],
  ["a\u0085b", "a b", []],
  [
    "ſoren SOREN",
    "soren",
    [
      [0, 5],
      [6, 11],
    ],
  ],
  ["Čapek Capek", "capek", [[6, 11]]],
  ["C\u030capek Čapek", "Čapek", [[7, 12]]],
  ["Straße", "strasse", []],
  ["\ud801", "\ud800", [[0, 1]]],
  ["\ud800", "\ud800", [[0, 1]]],
] as const;

export const scalarPhraseRanges = (rawText: string, phrase: string) => {
  const text = rawText.toWellFormed();
  const words = phrase
    .toWellFormed()
    .trim()
    .split(/\s+/u)
    .filter((word) => word.length > 0);
  if (words.length === 0) {
    return [];
  }
  return [
    ...text.matchAll(
      new RegExp(words.map(escapeRegExp).join(String.raw`\s+`), "giu"),
    ),
  ].map(({ index, 0: match }) => [index, index + match.length]);
};

// Exercise the translated regex paths behind phraseMatcher, including the
// shadowed lookaround and ECMAScript word-class cases fixed by the owner.
export const PHRASE_REGEX_CASES = [
  { source: String.raw`(?:a|ab)(?=c)`, text: "😀 abc ac" },
  {
    source: String.raw`(?<![\p{L}\p{M}\d.,])\d+(?![\p{L}\p{M}\d])`,
    text: "x12 12 12x 😀 25",
  },
  { source: String.raw`\b\w+\b`, text: "ſoren Kelvin Čapek ascii" },
  { source: String.raw`a\s+b`, text: "a\uFEFFb a\u0085b a\u202Fb" },
  { source: String.raw`a\\b`, text: String.raw`a\b ab` },
] as const;
