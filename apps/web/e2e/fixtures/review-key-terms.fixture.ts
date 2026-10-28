import { phraseMatcher, phraseRanges, resolveMarkedSegments } from "@/components/ai-suggestions/review-key-terms";
import { PHRASE_RANGE_CASES, PHRASE_REGEX_CASES, scalarPhraseRanges } from "@/components/ai-suggestions/review-key-terms.test-fixtures";

export const checkReviewMatchers = () => {
  const phrases = PHRASE_RANGE_CASES.map(([text, phrase, expected]) => {
    const ranges = phraseRanges(text, phrase);
    return {
      actual: ranges.map(({ start, end }) => [start, end]),
      expected,
      oracle: scalarPhraseRanges(text, phrase),
      reconstructed: resolveMarkedSegments({ text, ranges }).map((segment) => segment.text).join(""),
      text,
    };
  });
  const regexes = PHRASE_REGEX_CASES.map(({ source, text }) => {
    const matcher = phraseMatcher(source);
    return {
      actual: matcher.findIter(text).map(({ start, end }) => [start, end]),
      expected: [...text.matchAll(new RegExp(source, "giu"))].map(({ index, 0: match }) => [index, index + match.length]),
      replacement: matcher.replaceAll(text, ["<match>"]),
      expectedReplacement: text.replaceAll(new RegExp(source, "giu"), "<match>"),
    };
  });
  const whitespaceMismatches: number[] = [];
  for (let codePoint = 0; codePoint < 0x1_00_00; codePoint++) {
    const character = String.fromCodePoint(codePoint);
    if ((phraseRanges(`a${character}b`, "a b").length > 0) !== /\s/u.test(character)) {
      whitespaceMismatches.push(codePoint);
    }
  }
  return { phrases, regexes, whitespaceMismatches };
};
