import type { Edge } from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge";

export type WorkspaceViewDirection = "ltr" | "rtl";
export type WorkspaceViewDropPosition = "before" | "after";

export const toWorkspaceViewDropPosition = (
  edge: Edge | null,
  direction: WorkspaceViewDirection,
): WorkspaceViewDropPosition | null => {
  if (edge !== "left" && edge !== "right") {
    return null;
  }

  const isTrailingEdge =
    direction === "rtl" ? edge === "left" : edge === "right";
  return isTrailingEdge ? "after" : "before";
};

type ReorderWorkspaceViewIdsParams = {
  ids: readonly string[];
  draggedId: string;
  targetId: string;
  position: WorkspaceViewDropPosition;
};

export const reorderWorkspaceViewIds = ({
  ids,
  draggedId,
  targetId,
  position,
}: ReorderWorkspaceViewIdsParams): string[] | null => {
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
