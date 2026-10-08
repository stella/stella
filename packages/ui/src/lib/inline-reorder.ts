/**
 * Reordering for a horizontal row of items (tabs, chips) dragged with
 * pragmatic drag and drop. Edges match the hitbox package's `Edge`, so a
 * caller passes `extractClosestEdge(...)` straight through.
 */
type InlineDropEdge = "top" | "right" | "bottom" | "left";

export type InlineDirection = "ltr" | "rtl";
export type InlineDropPosition = "before" | "after";

export const toInlineDropPosition = (
  edge: InlineDropEdge | null,
  direction: InlineDirection,
): InlineDropPosition | null => {
  if (edge !== "left" && edge !== "right") {
    return null;
  }

  const isTrailingEdge =
    direction === "rtl" ? edge === "left" : edge === "right";
  return isTrailingEdge ? "after" : "before";
};

type ReorderInlineIdsParams = {
  ids: readonly string[];
  draggedId: string;
  targetId: string;
  position: InlineDropPosition;
};

/** The new order, or null when the drop leaves the order unchanged. */
export const reorderInlineIds = ({
  ids,
  draggedId,
  targetId,
  position,
}: ReorderInlineIdsParams): string[] | null => {
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
