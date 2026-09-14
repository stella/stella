import { DECISION_HEADNOTE_TRUNCATION_MARK } from "@stll/api-contract/case-law-text-field";

import { LIMITS } from "@/api/lib/limits";

const WORD_SEGMENTER = new Intl.Segmenter("und", { granularity: "word" });

/**
 * Fit text to the row budget without returning part of a Unicode word. An
 * over-budget first word yields only the truncation mark; the explicit flag
 * still distinguishes the preview from complete publisher text.
 */
export const truncateDecisionHeadnote = (text: string) => {
  const max = LIMITS.caseLawHeadnoteMaxChars;
  if (text.length <= max) {
    return { text, truncated: false };
  }
  const contentBudget = max - DECISION_HEADNOTE_TRUNCATION_MARK.length;
  let cut = 0;
  for (const { index, segment } of WORD_SEGMENTER.segment(text)) {
    const segmentEnd = index + segment.length;
    if (segmentEnd > contentBudget) {
      break;
    }
    cut = segmentEnd;
  }
  const prefix = text.slice(0, cut).trimEnd();
  return {
    text: `${prefix}${DECISION_HEADNOTE_TRUNCATION_MARK}`,
    truncated: true,
  };
};

/**
 * A decision's publisher summary as one line, whole: whitespace runs
 * collapsed, nothing cut. Null means the row has nothing to show.
 * `publisher-summary.ts` owns which source field wins; this helper owns only
 * how that text reads on one line.
 */
export const collapseDecisionHeadnote = (raw: unknown): string | null => {
  if (typeof raw !== "string") {
    return null;
  }
  const collapsed = raw.replace(/\s+/gu, " ").trim();
  return collapsed.length === 0 ? null : collapsed;
};

/**
 * The same line, fitted to the row budget. The preview is cut from the whole
 * reading above rather than from a second one, so a row that shows the rest
 * continues the text it was showing instead of replacing it.
 */
export const normalizeDecisionHeadnote = (raw: unknown) => {
  const collapsed = collapseDecisionHeadnote(raw);
  return collapsed === null ? null : truncateDecisionHeadnote(collapsed);
};
