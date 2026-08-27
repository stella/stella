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

type KanbanPointerHorizontalEdgeOptions = {
  input: "pointer";
  /** The drag's current viewport x coordinate for mouse or touch input. */
  currentClientX: number;
  overRect: ClientRect;
  /** Maps physical mouse and touch positions to the board's logical order. */
  direction?: KanbanDirection | undefined;
};

type KanbanKeyboardHorizontalEdgeOptions = {
  input: "keyboard";
  /** The source item's position in logical board order. */
  sourceIndex: number;
  /** The target item's position in logical board order. */
  targetIndex: number;
};

export type KanbanHorizontalEdgeOptions =
  | KanbanPointerHorizontalEdgeOptions
  | KanbanKeyboardHorizontalEdgeOptions;

/**
 * Resolves a horizontal insertion edge without consulting application data.
 *
 * Mouse and touch callers pass their current viewport coordinate. Keyboard
 * callers pass source and target indices, making every logical move
 * unambiguous. This deliberately avoids drag deltas, which include scroll
 * reconciliation and are not viewport coordinates.
 */
export const getKanbanHorizontalEdge = ({
  ...options
}: KanbanHorizontalEdgeOptions): KanbanHorizontalEdge => {
  if (options.input === "keyboard") {
    return options.sourceIndex < options.targetIndex
      ? KANBAN_HORIZONTAL_EDGES.after
      : KANBAN_HORIZONTAL_EDGES.before;
  }

  const {
    currentClientX,
    direction = KANBAN_DIRECTIONS.ltr,
    overRect,
  } = options;
  const currentX = currentClientX;
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
