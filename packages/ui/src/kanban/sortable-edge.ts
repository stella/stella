import type { ClientRect } from "@dnd-kit/core";

export const KANBAN_HORIZONTAL_EDGES = {
  before: "before",
  after: "after",
} as const;

export type KanbanHorizontalEdge =
  (typeof KANBAN_HORIZONTAL_EDGES)[keyof typeof KANBAN_HORIZONTAL_EDGES];

export type KanbanHorizontalEdgeOptions = {
  /** The drag's current viewport x coordinate for mouse or touch input. */
  currentClientX?: number | undefined;
  /** The active item's final translated rectangle, used for keyboard input. */
  translatedActiveRect: ClientRect;
  overRect: ClientRect;
};

/**
 * Resolves a horizontal insertion edge without consulting application data.
 *
 * Mouse and touch callers pass their current viewport coordinate. Keyboard
 * callers omit it, so the final translated active rectangle determines the
 * closest equivalent position. This deliberately avoids drag deltas, which
 * include scroll reconciliation and therefore are not viewport coordinates.
 */
export const getKanbanHorizontalEdge = ({
  currentClientX,
  translatedActiveRect,
  overRect,
}: KanbanHorizontalEdgeOptions): KanbanHorizontalEdge => {
  const currentX = currentClientX ?? getRectCenterX(translatedActiveRect);

  if (currentX < getRectCenterX(overRect)) {
    return KANBAN_HORIZONTAL_EDGES.before;
  }
  return KANBAN_HORIZONTAL_EDGES.after;
};

const getRectCenterX = ({ left, width }: ClientRect): number =>
  left + width / 2;
