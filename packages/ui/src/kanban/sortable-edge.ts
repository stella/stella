import type { ClientRect, DragEndEvent } from "@dnd-kit/core";

export const KANBAN_HORIZONTAL_EDGES = {
  before: "before",
  after: "after",
} as const;

export type KanbanHorizontalEdge =
  (typeof KANBAN_HORIZONTAL_EDGES)[keyof typeof KANBAN_HORIZONTAL_EDGES];

type KanbanHorizontalEdgeOptions = {
  activatorEvent: Event;
  deltaX: number;
  activeRect: ClientRect | null;
  overRect: ClientRect;
};

/**
 * Resolves a horizontal insertion edge without consulting application data.
 *
 * Pointer and touch drags keep the original grab point, then apply dnd-kit's
 * horizontal delta. Keyboard drags have no client coordinate, so their moved
 * active rectangle provides the closest equivalent.
 */
export const getKanbanHorizontalEdge = ({
  activatorEvent,
  deltaX,
  activeRect,
  overRect,
}: KanbanHorizontalEdgeOptions): KanbanHorizontalEdge => {
  const activatorX = getActivatorClientX(activatorEvent);
  const currentX =
    activatorX === null
      ? getRectCenterX(activeRect ?? overRect)
      : activatorX + deltaX;

  if (currentX < getRectCenterX(overRect)) {
    return KANBAN_HORIZONTAL_EDGES.before;
  }
  return KANBAN_HORIZONTAL_EDGES.after;
};

export const getKanbanHorizontalEdgeFromDragEnd = ({
  activatorEvent,
  delta,
  active,
  over,
}: DragEndEvent): KanbanHorizontalEdge | null => {
  const overRect = over?.rect;
  if (!overRect) {
    return null;
  }
  return getKanbanHorizontalEdge({
    activatorEvent,
    deltaX: delta.x,
    activeRect: active.rect.current.translated ?? active.rect.current.initial,
    overRect,
  });
};

const getActivatorClientX = (event: Event): number | null => {
  if (hasClientX(event)) {
    return event.clientX;
  }
  if (!hasTouchLists(event)) {
    return null;
  }
  return (
    event.touches.item(0)?.clientX ??
    event.changedTouches.item(0)?.clientX ??
    null
  );
};

const getRectCenterX = ({ left, width }: ClientRect): number =>
  left + width / 2;

type ClientXEvent = Event & { clientX: number };

const hasClientX = (event: Event): event is ClientXEvent =>
  "clientX" in event && typeof event.clientX === "number";

type TouchPoint = { clientX: number };

type TouchListEvent = Event & {
  touches: { item: (index: number) => TouchPoint | null };
  changedTouches: { item: (index: number) => TouchPoint | null };
};

const hasTouchLists = (event: Event): event is TouchListEvent =>
  "touches" in event && "changedTouches" in event;
