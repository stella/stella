/**
 * Where each sidenote sits in the margin, given where its clause sits on the
 * page.
 *
 * Tufte's rule and its one compromise: a note belongs beside the passage it
 * annotates, and two notes may not overlap. When both cannot hold, the later
 * note moves down — never up, so the reading order of the notes column always
 * matches the reading order of the document.
 *
 * Pure arithmetic over measurements the caller takes in one pass, so the
 * placement can be tested without a browser and the scroll handler stays a
 * read-then-write loop with no layout thrash in between.
 */

export type MarginNoteAnchor = {
  id: string;
  /**
   * Distance from the notes column's top edge to the top of the cited block,
   * or `null` when the block is not painted. Folio lays its pages out lazily,
   * so a clause the reader has not reached yet has no box to measure.
   */
  anchorTop: number | null;
  height: number;
};

export type MarginNotePlacement = {
  id: string;
  top: number;
};

export type MarginNoteLayout = {
  /** Notes with a place on screen, in document order. */
  placements: MarginNotePlacement[];
  /** Notes whose clause has been scrolled past, nearest first. */
  aboveIds: string[];
  /** Notes whose clause has not been reached, nearest first. */
  belowIds: string[];
};

type PaintedAnchor = { id: string; anchorTop: number; height: number };

type LayoutMarginNotesArgs = {
  anchors: readonly MarginNoteAnchor[];
  /** The notes column's own height. */
  viewportHeight: number;
  /** The least space left between two notes. */
  gap: number;
};

const nearestFirstAbove = (left: PaintedAnchor, right: PaintedAnchor): number =>
  right.anchorTop - left.anchorTop;

const nearestFirstBelow = (left: PaintedAnchor, right: PaintedAnchor): number =>
  left.anchorTop - right.anchorTop;

const idsOf = (anchors: readonly PaintedAnchor[]): string[] =>
  anchors.map((anchor) => anchor.id);

export const layoutMarginNotes = ({
  anchors,
  viewportHeight,
  gap,
}: LayoutMarginNotesArgs): MarginNoteLayout => {
  const above: PaintedAnchor[] = [];
  const farBelow: PaintedAnchor[] = [];
  const onScreen: PaintedAnchor[] = [];
  // Not painted: folio materializes pages as the reader moves toward them, so
  // the clause is one nobody has scrolled onto yet. Reported with the notes
  // below, whose pill scrolls the document at it.
  const unpainted: string[] = [];

  for (const { id, anchorTop, height } of anchors) {
    if (anchorTop === null) {
      unpainted.push(id);
      continue;
    }
    const painted: PaintedAnchor = { id, anchorTop, height };
    if (anchorTop < 0) {
      above.push(painted);
      continue;
    }
    if (anchorTop > viewportHeight) {
      farBelow.push(painted);
      continue;
    }
    onScreen.push(painted);
  }

  above.sort(nearestFirstAbove);
  farBelow.sort(nearestFirstBelow);
  onScreen.sort(nearestFirstBelow);

  const placements: MarginNotePlacement[] = [];
  // Pushed off the bottom by the notes above them: their clause is on screen
  // but the column has run out of room, so they are nearer than anything that
  // never fitted the viewport at all.
  const crowdedOut: PaintedAnchor[] = [];
  let cursor = 0;
  for (const candidate of onScreen) {
    const top = Math.max(candidate.anchorTop, cursor);
    if (top + candidate.height > viewportHeight) {
      crowdedOut.push(candidate);
      continue;
    }
    placements.push({ id: candidate.id, top });
    cursor = top + candidate.height + gap;
  }

  return {
    placements,
    aboveIds: idsOf(above),
    belowIds: [...idsOf(crowdedOut), ...idsOf(farBelow), ...unpainted],
  };
};
