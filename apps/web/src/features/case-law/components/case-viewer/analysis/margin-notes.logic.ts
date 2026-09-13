/**
 * Where each note sits in the margin gutter.
 *
 * The gutter is shared: the analysis layers and the current-section marker
 * hold its top in normal flow, and the notes are painted absolutely in the
 * region left under them. Both the region and the notes are therefore
 * measured against one origin — the region's own top edge — so a note can
 * never be drawn over the layers.
 *
 * Pure arithmetic over measurements the caller takes in one pass, so the
 * placement is testable without a browser and the scroll handler stays a
 * read-then-write loop with no layout thrash in between.
 */

/** Height assumed for a note that has not been measured yet. */
export const UNMEASURED_NOTE_HEIGHT_PX = 48;

/** The least space left between two notes. */
const NOTE_GAP_PX = 8;

export type AnchoredNote<TNote> = {
  /**
   * Distance from the region's top edge to the anchored text. Negative when
   * that text sits beside the layers above the region.
   */
  anchorTop: number;
  height: number;
  note: TNote;
};

export type PlacedNote<TNote> = {
  anchorTop: number;
  note: TNote;
  top: number;
};

/**
 * The measured notes region. Below the reader's wide breakpoint the stylesheet
 * collapses the whole gutter, and the region then measures zero: the
 * breakpoint stays owned by CSS alone, and the layout reads the result instead
 * of mirroring the number.
 */
export type NotesRegion = { width: number };

/** A gutter the reader cannot see is a gutter with nothing to draw in. */
export const gutterIsAvailable = ({ width }: NotesRegion): boolean => width > 0;

type PlaceGutterNotesArgs<TNote> = {
  notes: readonly AnchoredNote<TNote>[];
  region: NotesRegion;
};

/**
 * Tufte's rule and its two compromises: a note belongs beside the passage it
 * annotates; two notes may not overlap; and no note may rise into the layers
 * above the region. When they cannot all hold, the note moves down — never up,
 * so the notes column reads in document order.
 */
export const placeGutterNotes = <TNote>({
  notes,
  region,
}: PlaceGutterNotesArgs<TNote>): PlacedNote<TNote>[] => {
  if (!gutterIsAvailable(region)) {
    return [];
  }
  // Reading order, whatever order the caller handed them in: otherwise a late
  // arrival (a comment being written) lands below every earlier note instead
  // of beside its own paragraph.
  const ordered = [...notes].sort((a, b) => a.anchorTop - b.anchorTop);
  const placed: PlacedNote<TNote>[] = [];
  // Starts at the region's own top: the space above it belongs to the layers.
  let lastBottom = 0;
  for (const { anchorTop, height, note } of ordered) {
    const top = Math.max(anchorTop, lastBottom + NOTE_GAP_PX);
    placed.push({ anchorTop, note, top });
    lastBottom = top + height;
  }
  return placed;
};
