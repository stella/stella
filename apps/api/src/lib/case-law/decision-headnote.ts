import { LIMITS } from "@/api/lib/limits";

const WORD_SEGMENTER = new Intl.Segmenter("und", { granularity: "word" });

/**
 * Fit text to the row budget without returning part of a Unicode word. An
 * over-budget first word yields an empty prefix; the explicit truncation flag
 * still distinguishes it from an absent publisher summary.
 */
export const truncateDecisionHeadnote = (text: string) => {
  const max = LIMITS.caseLawHeadnoteMaxChars;
  if (text.length <= max) {
    return { text, truncated: false };
  }
  let cut = 0;
  const boundaryProbe = text.slice(0, max + 1);
  for (const { index, segment } of WORD_SEGMENTER.segment(boundaryProbe)) {
    const segmentEnd = index + segment.length;
    if (segmentEnd > max) {
      break;
    }
    cut = segmentEnd;
  }
  return { text: text.slice(0, cut).trimEnd(), truncated: true };
};

/**
 * A decision's publisher summary as one bounded line: whitespace runs are
 * collapsed, then the text is fitted to the row budget. Null means the row
 * has nothing to show. `publisher-summary.ts` owns which source field wins;
 * this helper owns only the public preview.
 */
export const normalizeDecisionHeadnote = (raw: unknown) => {
  if (typeof raw !== "string") {
    return null;
  }
  const collapsed = raw.replace(/\s+/gu, " ").trim();
  if (collapsed.length === 0) {
    return null;
  }
  return truncateDecisionHeadnote(collapsed);
};
