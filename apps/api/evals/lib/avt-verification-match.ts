/**
 * Which extracted claim answers for a labelled claim in a pipeline run: the
 * one in the same passage whose anchor covers most of the labelled words.
 * An extracted claim may answer for several labelled ones (it merged them);
 * a labelled claim no extracted claim covers by half is an extraction miss.
 */

/** A span of a block's text, as offsets into the whole block. */
export type PassageSpan = { passageIndex: number; start: number; end: number };

/** At least this share of the labelled words must lie inside the extracted
 *  claim's anchor. */
export const LABEL_COVERAGE_MIN = 0.5;

const overlap = (a: PassageSpan, b: PassageSpan): number =>
  a.passageIndex === b.passageIndex
    ? Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start))
    : 0;

/** The index of the extracted span covering the label best, or null. */
export const matchLabelledSpan = (
  label: PassageSpan,
  extracted: readonly PassageSpan[],
): number | null => {
  const length = Math.max(1, label.end - label.start);
  let best: { index: number; covered: number } | null = null;
  for (const [index, span] of extracted.entries()) {
    const covered = overlap(label, span) / length;
    if (
      covered >= LABEL_COVERAGE_MIN &&
      (best === null || covered > best.covered)
    ) {
      best = { index, covered };
    }
  }
  return best?.index ?? null;
};
