import { panic } from "better-result";

import type { MultiSelection } from "@/lib/multi-selection.logic";
import type { WorkspaceEntity } from "@/lib/types";
import { ENTITY_DRAG_TYPE } from "@/lib/workspaces/drag-constants";

/** What a card contributes to a drag: enough for every entity drop target. */
export type KanbanCardDragItem = {
  entityId: string;
  name: string;
  kind: WorkspaceEntity["kind"];
  mimeType: string | null;
  parentId: string | null;
  /**
   * The subgroup lane the card was rendered under; `null` is the Unassigned
   * lane, `undefined` a flat board with no lanes.
   */
  subgroupValue: string | null | undefined;
};

/** What a kanban drop needs per card: which one, and the lane it left. */
export type KanbanDraggedCard = Pick<
  KanbanCardDragItem,
  "entityId" | "subgroupValue"
>;

const KANBAN_DRAGGED_CARDS_KEY = "kanbanCards";

/**
 * The dragged card's source subgroup lane, read from the drag payload.
 * `undefined` means the payload carried no lane at all (a flat board, or a
 * card that never declared one) — distinct from `null`, the Unassigned
 * lane, which is a real source value a caller must not discard.
 */
export const readSourceSubgroupValue = (
  data: Record<string | symbol, unknown>,
): string | null | undefined => {
  const raw = data["subgroupValue"];
  if (typeof raw === "string") {
    return raw;
  }
  return raw === null ? null : undefined;
};

type BuildKanbanCardDragDataOptions = {
  /** The card under the pointer. */
  primary: KanbanCardDragItem;
  /** Every card the drag carries, `primary` first. */
  items: readonly KanbanCardDragItem[];
};

/**
 * The entity drag payload for one or several cards. Every field derives from
 * the same list, so the single-card fields older drop targets read
 * (`entityId`, `name`, ...) can never disagree with the multi-card ones.
 */
export const buildKanbanCardDragData = ({
  primary,
  items,
}: BuildKanbanCardDragDataOptions): Record<string, unknown> => ({
  type: ENTITY_DRAG_TYPE,
  entityId: primary.entityId,
  entityIds: items.map((item) => item.entityId),
  entities: items.map((item) => ({
    entityId: item.entityId,
    name: item.name,
    kind: item.kind,
    mimeType: item.mimeType,
    parentId: item.parentId,
  })),
  name: primary.name,
  kind: primary.kind,
  mimeType: primary.mimeType,
  subgroupValue: primary.subgroupValue,
  [KANBAN_DRAGGED_CARDS_KEY]: items.map((item) => ({
    entityId: item.entityId,
    subgroupValue: item.subgroupValue,
  })),
});

const isDraggedCard = (value: unknown): value is KanbanDraggedCard => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (!("entityId" in value) || typeof value.entityId !== "string") {
    return false;
  }
  if (!("subgroupValue" in value)) {
    return true;
  }
  const lane = value.subgroupValue;
  return lane === undefined || lane === null || typeof lane === "string";
};

/**
 * The cards a drop moves. An entity drag that did not start on a kanban card
 * (a table row, a tree row) carries one entity and no card list.
 */
export const readKanbanDraggedCards = (
  data: Record<string | symbol, unknown>,
): KanbanDraggedCard[] => {
  const cards = data[KANBAN_DRAGGED_CARDS_KEY];
  if (Array.isArray(cards) && cards.length > 0 && cards.every(isDraggedCard)) {
    return cards;
  }
  const entityId = data["entityId"];
  if (typeof entityId !== "string") {
    return [];
  }
  return [{ entityId, subgroupValue: readSourceSubgroupValue(data) }];
};

/** The cards a drag of `primary` carries: the selection, or the card alone. */
export const getDraggedItems = (
  primary: KanbanCardDragItem,
  selected: ReadonlyMap<string, KanbanCardDragItem>,
): KanbanCardDragItem[] => {
  if (selected.size < 2 || !selected.has(primary.entityId)) {
    return [primary];
  }
  const items = [primary];
  for (const [entityId, item] of selected) {
    if (entityId !== primary.entityId) {
      items.push(item);
    }
  }
  return items;
};

// -- Marquee --

export type ViewportPoint = { x: number; y: number };

export type ViewportRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

/** A pointer travelling less than this is a click, not a marquee. */
export const MARQUEE_DRAG_THRESHOLD_PX = 4;

export const hasPassedMarqueeThreshold = (
  start: ViewportPoint,
  current: ViewportPoint,
): boolean =>
  Math.hypot(current.x - start.x, current.y - start.y) >=
  MARQUEE_DRAG_THRESHOLD_PX;

/** The rectangle spanned by two corners, whichever way the pointer went. */
export const getMarqueeRect = (
  start: ViewportPoint,
  current: ViewportPoint,
): ViewportRect => ({
  left: Math.min(start.x, current.x),
  top: Math.min(start.y, current.y),
  right: Math.max(start.x, current.x),
  bottom: Math.max(start.y, current.y),
});

/** Overlap with positive area: a marquee that only grazes an edge misses. */
export const rectsIntersect = (a: ViewportRect, b: ViewportRect): boolean =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

export const MARQUEE_MODE = {
  /** A plain drag: the marquee is the whole selection. */
  replace: "replace",
  /** Cmd/Ctrl or Shift held: the marquee adds to what was selected. */
  add: "add",
} as const;

export type MarqueeMode = (typeof MARQUEE_MODE)[keyof typeof MARQUEE_MODE];

type ApplyMarqueeSelectionOptions = {
  /** The selection when the marquee started. */
  base: MultiSelection;
  hitIds: readonly string[];
  mode: MarqueeMode;
};

/**
 * Recomputed from the starting selection on every pointer move, so a card
 * the marquee shrinks back off is deselected again.
 */
export const applyMarqueeSelection = ({
  base,
  hitIds,
  mode,
}: ApplyMarqueeSelectionOptions): MultiSelection => {
  switch (mode) {
    case MARQUEE_MODE.replace:
      return { selectedIds: new Set(hitIds), anchorId: null };
    case MARQUEE_MODE.add:
      return {
        selectedIds: new Set([...base.selectedIds, ...hitIds]),
        anchorId: base.anchorId,
      };
    default:
      mode satisfies never;
      return panic(`Unhandled marquee mode: ${String(mode)}`);
  }
};

type ScrollViewportHitOptions = {
  point: ViewportPoint;
  /** The element's border box, from `getBoundingClientRect`. */
  rect: Pick<ViewportRect, "left" | "top">;
  clientLeft: number;
  clientTop: number;
  clientWidth: number;
  clientHeight: number;
};

/**
 * Whether a point lies inside an element's client area, which excludes its
 * borders and scrollbars. `clientLeft` covers a scrollbar drawn on the
 * inline-start side under `dir="rtl"`, so the test holds in both directions.
 */
export const isInsideClientArea = ({
  point,
  rect,
  clientLeft,
  clientTop,
  clientWidth,
  clientHeight,
}: ScrollViewportHitOptions): boolean => {
  const left = rect.left + clientLeft;
  const top = rect.top + clientTop;
  return (
    point.x >= left &&
    point.x < left + clientWidth &&
    point.y >= top &&
    point.y < top + clientHeight
  );
};
