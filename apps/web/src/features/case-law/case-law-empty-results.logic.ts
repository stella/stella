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

/**
 * What a rewrite that just landed is for. The box stays editable while the
 * model answers, so a rewrite of an entry the reader has since changed, of
 * another jurisdiction, or of a search they have since asked to require every
 * word of, is stale and dropped rather than written over their choice; one
 * that says the same words would search the same nothing again.
 */
export type RefineOutcome = "stale" | "unchanged" | "manual" | "automatic";

type RefineOutcomeInput = {
  asked: {
    country: string;
    entry: string;
    strict: boolean;
    automatic: boolean;
  };
  current: { country: string; query: string; strict: boolean };
  refined: string;
};

export const refineOutcome = ({
  asked,
  current,
  refined,
}: RefineOutcomeInput): RefineOutcome => {
  if (
    asked.entry !== current.query.trim() ||
    asked.country !== current.country ||
    asked.strict !== current.strict
  ) {
    return "stale";
  }
  if (refined.trim() === asked.entry) {
    return "unchanged";
  }
  return asked.automatic ? "automatic" : "manual";
};

type AutoRewriteInput = {
  /** The search ran as a search (not a browse or an identifier lookup). */
  isTextSearch: boolean;
  /** The query the rows answer. */
  query: string;
  /**
   * What the box holds now. The rewrite runs on the box, so a reader who has
   * typed on since the search ran is left alone: their new words have not
   * been searched yet.
   */
  typedQuery: string;
  /** Rows on the page on screen. */
  resultCount: number;
  /**
   * The page on screen is the first. Only an empty first page says the
   * search matched nothing; a later page can be empty while matches exist.
   */
  isFirstPage: boolean;
  /** The rows on screen answer this query, not an earlier one. */
  rowsAnswerQuery: boolean;
  /** The page already shows a rewrite: never rewrite a rewrite. */
  rewrittenFrom: string | undefined;
  /** The reader went back to their own words: leave them there. */
  rewriteOff: boolean;
  /**
   * The page already tried this search, whatever came of it. A rewrite that
   * failed or said the same words is not asked for again because the reader
   * typed and deleted a character.
   */
  alreadyAttempted: boolean;
  /**
   * The reader asked for every word: an empty answer to that is the answer,
   * not a cue to search different, looser words.
   */
  strict: boolean;
};

/**
 * Whether the page rewrites this search by itself. The caller adds what only
 * the session knows: a signed-in reader whose organization has AI. A public
 * reader is never spent on.
 */
export const shouldAutoRewrite = ({
  isTextSearch,
  query,
  typedQuery,
  resultCount,
  isFirstPage,
  rowsAnswerQuery,
  rewrittenFrom,
  rewriteOff,
  alreadyAttempted,
  strict,
}: AutoRewriteInput): boolean =>
  isTextSearch &&
  rowsAnswerQuery &&
  typedQuery.trim() === query.trim() &&
  isFirstPage &&
  resultCount === 0 &&
  rewrittenFrom === undefined &&
  !rewriteOff &&
  !alreadyAttempted &&
  !strict &&
  isQuestionLike(query);
