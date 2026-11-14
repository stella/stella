/**
 * Which extracted claim answers for a labelled claim in a pipeline run: the
 * one in the same passage sharing the most words with it, when at least
 * half of the shorter of the two lies inside the other. So an extracted
 * claim that merged several labelled ones answers for each, and one that
 * kept only part of a labelled claim answers for it; a labelled claim no
 * extracted claim overlaps that much is an extraction miss.
 */

/** A span of a block's text, as offsets into the whole block. */
export type PassageSpan = { passageIndex: number; start: number; end: number };

/** At least this share of the shorter span must lie inside the other. */
const SPAN_OVERLAP_MIN = 0.5;

const overlap = (a: PassageSpan, b: PassageSpan): number =>
  a.passageIndex === b.passageIndex
    ? Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start))
    : 0;

const length = (span: PassageSpan): number =>
  Math.max(1, span.end - span.start);

/** The index of the extracted span sharing most with the label, or null. */
export const matchLabelledSpan = (
  label: PassageSpan,
  extracted: readonly PassageSpan[],
): number | null => {
  let best: { index: number; shared: number } | null = null;
  for (const [index, span] of extracted.entries()) {
    const shared = overlap(label, span);
    if (
      shared / Math.min(length(label), length(span)) >= SPAN_OVERLAP_MIN &&
      (best === null || shared > best.shared)
    ) {
      best = { index, shared };
    }
  }
  return best?.index ?? null;
};
