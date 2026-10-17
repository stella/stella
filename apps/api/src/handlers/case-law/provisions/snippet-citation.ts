import { caseLawLiteralMatcher } from "@/api/handlers/case-law/literal-matcher";

/** Exact UTF-16 offsets in the displayed sentence, only when the print is unambiguous. */
export const snippetCitation = (
  sentenceText: string | null,
  printText: string | null,
) => {
  if (sentenceText === null || printText === null || printText === "") {
    return null;
  }
  const matches = caseLawLiteralMatcher(printText).findOverlappingIter(
    sentenceText.toWellFormed(),
  );
  const [match, ...others] = matches;
  if (match === undefined || others.length > 0) {
    return null;
  }
  return { start: match.start, end: match.end };
};
