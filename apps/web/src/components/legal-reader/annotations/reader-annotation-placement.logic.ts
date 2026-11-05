import { placeReaderMarks } from "@stll/legal-ast/reader-text-quote";
import type {
  ReaderTextPiece,
  ReaderTextQuoteOrphanReason,
} from "@stll/legal-ast/reader-text-quote";

import type { ReaderAnnotation } from "@/components/legal-reader/annotations/reader-annotations-query";

/** A stored mark the document's current text has no single place for. */
export type OrphanedReaderAnnotation = {
  annotation: ReaderAnnotation;
  reason: ReaderTextQuoteOrphanReason;
};

type PlacedReaderAnnotations = {
  /** The marks to draw, at the anchor and offsets their words have now. */
  placed: ReaderAnnotation[];
  orphaned: OrphanedReaderAnnotation[];
};

const NOTHING_PLACED: PlacedReaderAnnotations = { placed: [], orphaned: [] };

/**
 * The reader's marks in the text on screen. Every surface that draws marks
 * reads them through this: a stored anchor names a position in the text the
 * mark was made on, and a re-parse since can have renumbered it onto other
 * words. Until the text has loaded nothing is placed or orphaned.
 */
export const placeReaderAnnotations = (
  annotations: readonly ReaderAnnotation[],
  text: readonly ReaderTextPiece[] | null,
): PlacedReaderAnnotations => {
  if (text === null) {
    return NOTHING_PLACED;
  }
  const { orphaned, placed } = placeReaderMarks(annotations, text);
  return {
    placed,
    orphaned: orphaned.map(({ mark, reason }) => ({
      annotation: mark,
      reason,
    })),
  };
};
