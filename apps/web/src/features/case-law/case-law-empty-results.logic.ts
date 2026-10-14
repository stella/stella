/**
 * When the case-law page rewrites a search on its own. A judgment is not
 * written the way a question is asked, so a question that found nothing is
 * worth one AI rewrite into the words decisions use. A docket number or a
 * two-word phrase that found nothing is not: there the reader meant those
 * words, and the empty results say so.
 */

/** A question mark ends it, or it runs to a sentence's worth of words. */
const QUESTION_WORD_COUNT = 4;

export const isQuestionLike = (query: string): boolean => {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return false;
  }
  // Both the Latin and the Arabic question mark.
  if (/[?؟]$/u.test(trimmed)) {
    return true;
  }
  return trimmed.split(/\s+/u).length >= QUESTION_WORD_COUNT;
};

type AutoRewriteInput = {
  /** The search ran as a search (not a browse or an identifier lookup). */
  isTextSearch: boolean;
  query: string;
  resultCount: number;
  /** The rows on screen answer this query, not an earlier one. */
  rowsAnswerQuery: boolean;
  /** The page already shows a rewrite: never rewrite a rewrite. */
  rewrittenFrom: string | undefined;
  /** The reader went back to their own words: leave them there. */
  rewriteOff: boolean;
};

/**
 * Whether the page rewrites this search by itself. The caller adds what only
 * the session knows: a signed-in reader whose organization has AI. A public
 * reader is never spent on.
 */
export const shouldAutoRewrite = ({
  isTextSearch,
  query,
  resultCount,
  rowsAnswerQuery,
  rewrittenFrom,
  rewriteOff,
}: AutoRewriteInput): boolean =>
  isTextSearch &&
  rowsAnswerQuery &&
  resultCount === 0 &&
  rewrittenFrom === undefined &&
  !rewriteOff &&
  isQuestionLike(query);
