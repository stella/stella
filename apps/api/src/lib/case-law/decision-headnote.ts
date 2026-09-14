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

/** Whitespace inside a line. A break between lines is not it. */
const HORIZONTAL_WHITESPACE = /[^\S\n]+/gu;

/** Every spelling of a line break a publisher payload arrives with. */
const LINE_BREAK = /\r\n?|\n/u;

/**
 * A decision's publisher summary as the publisher set it, whole: the spacing
 * inside each line collapsed, the breaks between them kept as one newline
 * each. Null means the row has nothing to show.
 *
 * The breaks carry meaning a space cannot: a Czech or Slovak headnote is
 * often numbered points ("I.", "II.", "III."), and run together they read as
 * one sentence that contradicts itself. Blank lines collapse to a single
 * break because the row's budget is spent on words, not on air.
 *
 * `publisher-summary.ts` owns which source field wins; this helper owns only
 * how that text reads.
 */
export const collapseDecisionHeadnote = (raw: unknown): string | null => {
  if (typeof raw !== "string") {
    return null;
  }
  const lines: string[] = [];
  for (const line of raw.split(LINE_BREAK)) {
    const collapsed = line.replace(HORIZONTAL_WHITESPACE, " ").trim();
    if (collapsed.length > 0) {
      lines.push(collapsed);
    }
  }
  const text = lines.join("\n");
  return text.length === 0 ? null : text;
};

/**
 * One term of a classification. A term is one line by definition, so the
 * breaks a headnote keeps are spaces here: a tag drawn over two lines is a
 * tag the reader has to work out.
 */
const collapseDecisionTerm = (raw: unknown): string | null => {
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

/**
 * A publisher's classification as the terms a row draws, fitted to the same
 * row the prose preview gets: at most `caseLawHeadnoteKeywords` terms, and no
 * more of them than the character budget holds. Null means the publisher filed
 * the decision under nothing.
 */
export const normalizeDecisionKeywords = (raw: unknown) => {
  if (!Array.isArray(raw)) {
    return null;
  }
  const terms: string[] = [];
  for (const value of raw) {
    const term = collapseDecisionTerm(value);
    // A repeated term is a publisher's bookkeeping, not a second tag.
    if (term !== null && !terms.includes(term)) {
      terms.push(term);
    }
  }
  if (terms.length === 0) {
    return null;
  }

  const items: string[] = [];
  let budget = LIMITS.caseLawHeadnoteMaxChars;
  for (const term of terms) {
    // A term is a term: the row drops the ones past its budget rather than
    // drawing a tag cut in half.
    if (
      term.length > budget ||
      items.length >= LIMITS.caseLawHeadnoteKeywords
    ) {
      break;
    }
    budget -= term.length;
    items.push(term);
  }
  if (items.length === 0) {
    // A single term over the whole budget is still the only hook the row has.
    items.push(truncateDecisionHeadnote(terms[0] ?? "").text);
  }
  return { items, omitted: terms.length - items.length };
};
