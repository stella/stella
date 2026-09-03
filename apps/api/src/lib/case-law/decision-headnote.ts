import { LIMITS } from "@/api/lib/limits";

const ELLIPSIS = "…";
/** Cut on a word boundary only when that keeps most of the budget. */
const WORD_BOUNDARY_MIN_RATIO = 0.6;

/**
 * A decision's publisher summary as one bounded line: whitespace runs
 * collapsed, then cut to the row budget on a word boundary. Null when there
 * is nothing to show, so the row can omit the line rather than render an
 * empty one. What may fill it, and in what order, is
 * `publisher-summary.ts`; this is only how it is fitted to a row.
 */
export const normalizeDecisionHeadnote = (raw: unknown): string | null => {
  if (typeof raw !== "string") {
    return null;
  }
  const collapsed = raw.replace(/\s+/gu, " ").trim();
  if (collapsed.length === 0) {
    return null;
  }
  const max = LIMITS.caseLawHeadnoteMaxChars;
  if (collapsed.length <= max) {
    return collapsed;
  }
  const budget = max - ELLIPSIS.length;
  // A cut inside a surrogate pair would leave a lone high surrogate before
  // the mark: back off one code unit when the budget lands there.
  const cut16 = collapsed.slice(0, budget);
  const head = /[\uD800-\uDBFF]$/u.test(cut16) ? cut16.slice(0, -1) : cut16;
  const lastSpace = head.lastIndexOf(" ");
  const cut =
    lastSpace >= Math.floor(budget * WORD_BOUNDARY_MIN_RATIO)
      ? head.slice(0, lastSpace)
      : head;
  return `${cut.trimEnd()}${ELLIPSIS}`;
};
