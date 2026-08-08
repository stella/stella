import type { Edge } from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge";

import type { TextDirection } from "@/i18n/i18n-store";

/**
 * Where a dragged view lands relative to the tab it was dropped on. Logical, so
 * the caller resolves the physical edge once, where the direction is known.
 */
export type ViewDropPosition = "before" | "after";

/**
 * Maps the physical edge the pointer is closest to onto a position in the view
 * order. `right` means "later in the order" only under `ltr`; in `rtl` the tab
 * strip is mirrored and the left edge is the trailing one.
 */
export const toViewDropPosition = (
  edge: Edge | null,
  direction: TextDirection,
): ViewDropPosition | null => {
  if (edge !== "left" && edge !== "right") {
    return null;
  }

  const isTrailingEdge =
    direction === "rtl" ? edge === "left" : edge === "right";
  return isTrailingEdge ? "after" : "before";
};

type ReorderViewIdsArgs = {
  ids: readonly string[];
  draggedId: string;
  targetId: string;
  position: ViewDropPosition;
};

/**
 * Returns the view order produced by dropping `draggedId` beside `targetId`, or
 * `null` when the drop changes nothing. The insertion point is expressed
 * relative to the target rather than by its index, so the result depends only
 * on which edge was hit and never on the direction the tab was dragged from.
 *
 * Not `reorderWithEdge` from the hitbox package, already a dependency: it
 * hardcodes `right` as later in the order, so it mirrors wrongly under RTL.
 */
export const reorderViewIds = ({
  ids,
  draggedId,
  targetId,
  position,
}: ReorderViewIdsArgs): string[] | null => {
  if (
    draggedId === targetId ||
    !ids.includes(draggedId) ||
    !ids.includes(targetId)
  ) {
    return null;
  }

  const withoutDragged = ids.filter((id) => id !== draggedId);
  const targetIndex = withoutDragged.indexOf(targetId);
  const reordered = withoutDragged.toSpliced(
    position === "after" ? targetIndex + 1 : targetIndex,
    0,
    draggedId,
  );

  return reordered.every((id, index) => id === ids[index]) ? null : reordered;
};
