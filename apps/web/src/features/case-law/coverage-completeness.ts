/** The numbers a completeness is read from, whichever scope states them. */
type CaseLawCompletenessCounts = {
  /** What the publisher says it holds. */
  reported: number;
  /** What the corpus holds of it. */
  stored: number;
  /**
   * Decisions the publisher lists that the source's own reconciliation found
   * missing from the corpus; null where the source has not been reconciled.
   */
  knownMissing: number | null;
};

/**
 * The one place a stored count and a publisher's total become the percentage
 * the page prints. Every rule is about not overstating.
 *
 * It is capped at 100 because the denominator is an observation, not a live
 * figure: a total read weeks ago can be smaller than what the corpus holds
 * today, and "104 %" reads as a broken page rather than as the lag it is.
 *
 * The cap is not evidence of completeness, though. A stored count can reach
 * the publisher's total while decisions are missing, when the corpus also
 * holds decisions the total no longer lists. Where the source has been
 * reconciled decision by decision, what it found missing is subtracted from
 * the total before the counts are compared, so a source with a known gap
 * never reads as complete.
 *
 * It rounds down because 100 must mean complete. Rounding 99.6 % to 100 tells
 * a reader every decision is held while four in a thousand are missing, and
 * nothing on the page could correct that.
 *
 * Null, not zero, when nothing was reported: a corpus nobody has measured is
 * not a corpus measured at nothing.
 */
export const caseLawCompletenessPercent = ({
  reported,
  stored,
  knownMissing,
}: CaseLawCompletenessCounts): number | null => {
  if (reported <= 0) {
    return null;
  }
  const missing = Math.min(Math.max(knownMissing ?? 0, 0), reported);
  const held = Math.min(stored, reported - missing);
  if (held >= reported) {
    return 100;
  }
  return Math.floor((Math.max(held, 0) / reported) * 100);
};
