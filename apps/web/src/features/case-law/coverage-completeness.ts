/** The two numbers a completeness is read from, whichever scope states them. */
type CaseLawCompletenessCounts = {
  /** What the publisher says it holds. */
  reported: number;
  /** What the corpus holds of it. */
  stored: number;
};

/**
 * The one place a stored count and a publisher's total become the percentage
 * the page prints. Two rules, and both of them are about not overstating.
 *
 * It is capped at 100 because the denominator is an observation, not a live
 * figure: a total read weeks ago can be smaller than what the corpus holds
 * today, and "104 %" reads as a broken page rather than as the lag it is. The
 * overshoot is a fact about the denominator, so it is reported beside the
 * ratio by `caseLawCompletenessExceedsReported` instead of inside it.
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
}: CaseLawCompletenessCounts): number | null => {
  if (reported <= 0) {
    return null;
  }
  if (stored >= reported) {
    return 100;
  }
  return Math.floor((stored / reported) * 100);
};

/** Whether the corpus holds more than the publisher's last stated total. */
export const caseLawCompletenessExceedsReported = ({
  reported,
  stored,
}: CaseLawCompletenessCounts): boolean => reported > 0 && stored > reported;
