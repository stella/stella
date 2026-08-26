import type { ClientRect } from "@dnd-kit/core";

export const KANBAN_HORIZONTAL_EDGES = {
  before: "before",
  after: "after",
} as const;

export type KanbanHorizontalEdge =
  (typeof KANBAN_HORIZONTAL_EDGES)[keyof typeof KANBAN_HORIZONTAL_EDGES];

export const KANBAN_DIRECTIONS = {
  ltr: "ltr",
  rtl: "rtl",
} as const;

export type KanbanDirection =
  (typeof KANBAN_DIRECTIONS)[keyof typeof KANBAN_DIRECTIONS];

export type KanbanHorizontalEdgeOptions = {
  /** The drag's current viewport x coordinate for mouse or touch input. */
  currentClientX?: number | undefined;
  /** The active item's final translated rectangle, used for keyboard input. */
  translatedActiveRect: ClientRect;
  overRect: ClientRect;
  /** The source item's position when a keyboard move needs a logical edge. */
  sourceIndex?: number | undefined;
  /** The target item's position when a keyboard move needs a logical edge. */
  targetIndex?: number | undefined;
  /** Maps physical mouse and touch positions to the board's logical order. */
  direction?: KanbanDirection | undefined;
};

/**
 * Resolves a horizontal insertion edge without consulting application data.
 *
 * Mouse and touch callers pass their current viewport coordinate. Keyboard
 * callers can pass source and target indices to resolve a logical move even
 * when the rectangles share a center. Otherwise the final translated active
 * rectangle provides the closest equivalent position. This deliberately avoids
 * drag deltas, which include scroll reconciliation and are not viewport
 * coordinates.
 */
export const getKanbanHorizontalEdge = ({
  currentClientX,
  translatedActiveRect,
  overRect,
  sourceIndex,
  targetIndex,
  direction = KANBAN_DIRECTIONS.ltr,
}: KanbanHorizontalEdgeOptions): KanbanHorizontalEdge => {
  if (
    currentClientX === undefined &&
    sourceIndex !== undefined &&
    targetIndex !== undefined
  ) {
    return sourceIndex < targetIndex
      ? KANBAN_HORIZONTAL_EDGES.after
      : KANBAN_HORIZONTAL_EDGES.before;
  }

  const currentX = currentClientX ?? getRectCenterX(translatedActiveRect);
  const physicalEdge =
    currentX < getRectCenterX(overRect)
      ? KANBAN_HORIZONTAL_EDGES.before
      : KANBAN_HORIZONTAL_EDGES.after;

  if (direction === KANBAN_DIRECTIONS.rtl) {
    return physicalEdge === KANBAN_HORIZONTAL_EDGES.before
      ? KANBAN_HORIZONTAL_EDGES.after
      : KANBAN_HORIZONTAL_EDGES.before;
  }
  return physicalEdge;
};

const getRectCenterX = ({ left, width }: ClientRect): number =>
  left + width / 2;
