import {
  closestCorners,
  getFirstCollision,
  pointerWithin,
  type CollisionDetection,
  type DroppableContainer,
  type KeyboardCoordinateGetter,
  type SensorContext,
  type UniqueIdentifier,
} from "@dnd-kit/core";

export const KANBAN_DROP_TARGET_TYPES = {
  CELL: "kanban-cell",
  ITEM: "kanban-item",
} as const;

export type KanbanSortableCellPosition = {
  column: number;
  lane: number;
};

export type KanbanVirtualScrollRequest = {
  itemId: UniqueIdentifier;
  type: "item";
};

export type KanbanCellVirtualNavigation =
  | { type: "static" }
  | {
      requestScroll: (request: KanbanVirtualScrollRequest) => void;
      type: "virtual";
    };

export type KanbanCellDropData = {
  itemIds: readonly UniqueIdentifier[];
  navigation: KanbanCellVirtualNavigation;
  position: KanbanSortableCellPosition;
  type: "kanban-cell";
};

type KanbanKeyboardTargetState =
  | { type: "idle" }
  | { targetId: UniqueIdentifier; type: "pending" }
  | { targetId: UniqueIdentifier; type: "ready" };

export type KanbanItemDropData = {
  navigation: {
    current: KanbanKeyboardTargetState;
  };
  type: "kanban-item";
};

type SortableData = {
  containerId: UniqueIdentifier;
  index: number;
  items: readonly UniqueIdentifier[];
};

type NavigationCell = KanbanCellDropData & {
  id: UniqueIdentifier;
};

const isRecord = (value: unknown): value is Record<PropertyKey, unknown> =>
  typeof value === "object" && value !== null;

const isUniqueIdentifier = (value: unknown): value is UniqueIdentifier =>
  typeof value === "string" || typeof value === "number";

const isCellPosition = (value: unknown): value is KanbanSortableCellPosition =>
  isRecord(value) &&
  typeof value["column"] === "number" &&
  typeof value["lane"] === "number" &&
  Number.isInteger(value["column"]) &&
  Number.isInteger(value["lane"]) &&
  value["column"] >= 0 &&
  value["lane"] >= 0;

const isKanbanCellVirtualNavigation = (
  value: unknown,
): value is KanbanCellVirtualNavigation =>
  isRecord(value) &&
  (value["type"] === "static" ||
    (value["type"] === "virtual" &&
      typeof value["requestScroll"] === "function"));

export const isKanbanCellDropData = (
  value: unknown,
): value is KanbanCellDropData =>
  isRecord(value) &&
  value["type"] === KANBAN_DROP_TARGET_TYPES.CELL &&
  Array.isArray(value["itemIds"]) &&
  value["itemIds"].every(isUniqueIdentifier) &&
  isKanbanCellVirtualNavigation(value["navigation"]) &&
  isCellPosition(value["position"]);

const isKanbanItemDropData = (value: unknown): value is KanbanItemDropData => {
  if (!isRecord(value) || value["type"] !== KANBAN_DROP_TARGET_TYPES.ITEM) {
    return false;
  }
  const navigation = value["navigation"];
  const current = isRecord(navigation) ? navigation["current"] : undefined;
  return (
    isRecord(navigation) &&
    isRecord(current) &&
    (current["type"] === "idle" ||
      ((current["type"] === "ready" || current["type"] === "pending") &&
        isUniqueIdentifier(current["targetId"])))
  );
};

export const getKanbanKeyboardTargetState = (
  value: unknown,
): KanbanKeyboardTargetState | undefined =>
  isKanbanItemDropData(value) ? value.navigation.current : undefined;

/**
 * dnd-kit computes collisions while rendering but publishes the resulting drop
 * target to its sensor context a render later, and resolves a drop from that
 * published value. A drag that ends before the two agree, which every input
 * can do because a single move produces a single render, drops the item on the
 * previously published target.
 */
export const isKanbanDropSettled = ({
  collisions,
  over,
}: Pick<SensorContext, "collisions" | "over">): boolean =>
  getFirstCollision(collisions, "id") === (over?.id ?? null);

export const clearKanbanKeyboardTarget = (value: unknown): void => {
  if (isKanbanItemDropData(value) && value.navigation.current.type !== "idle") {
    value.navigation.current = { type: "idle" };
  }
};

const getSortableData = (value: unknown): SortableData | null => {
  if (!isRecord(value)) {
    return null;
  }
  const sortable = value["sortable"];
  if (
    !isRecord(sortable) ||
    !isUniqueIdentifier(sortable["containerId"]) ||
    typeof sortable["index"] !== "number" ||
    !Number.isInteger(sortable["index"]) ||
    !Array.isArray(sortable["items"]) ||
    !sortable["items"].every(isUniqueIdentifier)
  ) {
    return null;
  }
  return {
    containerId: sortable["containerId"],
    index: sortable["index"],
    items: sortable["items"],
  };
};

const isKanbanDroppable = ({ data }: DroppableContainer): boolean => {
  const value: unknown = data.current;
  return isKanbanCellDropData(value) || isKanbanItemDropData(value);
};

/**
 * Pointer and touch input must be inside a registered board target. Once that
 * boundary is established, closest corners gives stable ranking across cells.
 */
export const KANBAN_BOARD_COLLISION_DETECTION: CollisionDetection = (args) => {
  const boardContainers = args.droppableContainers.filter(isKanbanDroppable);
  if (args.pointerCoordinates === null) {
    const activeData: unknown = args.active.data.current;
    if (isKanbanItemDropData(activeData)) {
      if (activeData.navigation.current.type === "pending") {
        return [];
      }
      if (activeData.navigation.current.type !== "ready") {
        return closestCorners({
          ...args,
          droppableContainers: boardContainers,
        });
      }
      const { targetId } = activeData.navigation.current;
      return boardContainers.some(({ id }) => id === targetId)
        ? [{ id: targetId }]
        : [];
    }
    return closestCorners({ ...args, droppableContainers: boardContainers });
  }

  const intersections = pointerWithin({
    ...args,
    droppableContainers: boardContainers,
  });
  if (intersections.length === 0) {
    return [];
  }
  const intersectingIds = new Set(
    intersections.map((intersection) => intersection.id),
  );
  return closestCorners({
    ...args,
    droppableContainers: boardContainers.filter(({ id }) =>
      intersectingIds.has(id),
    ),
  });
};

type NavigationDirection = "down" | "left" | "right" | "up";

type GetKeyboardTargetOptions = {
  activeId: UniqueIdentifier;
  cells: readonly NavigationCell[];
  currentCellId: UniqueIdentifier;
  currentOverId: UniqueIdentifier;
  direction: NavigationDirection;
};

const getAdjacentCell = (
  cells: readonly NavigationCell[],
  current: NavigationCell,
  direction: NavigationDirection,
): NavigationCell | undefined => {
  let columnOffset = 0;
  let laneOffset = 0;
  switch (direction) {
    case "down":
      laneOffset = 1;
      break;
    case "left":
      columnOffset = -1;
      break;
    case "right":
      columnOffset = 1;
      break;
    case "up":
      laneOffset = -1;
      break;
  }
  return cells.find(
    ({ position }) =>
      position.column === current.position.column + columnOffset &&
      position.lane === current.position.lane + laneOffset,
  );
};

export const getKanbanKeyboardTarget = ({
  activeId,
  cells,
  currentCellId,
  currentOverId,
  direction,
}: GetKeyboardTargetOptions): UniqueIdentifier | undefined => {
  const currentCell = cells.find(({ id }) => id === currentCellId);
  if (currentCell === undefined) {
    return undefined;
  }
  const overIndex = currentCell.itemIds.indexOf(currentOverId);
  const activeIndex = currentCell.itemIds.indexOf(activeId);
  const currentIndex = overIndex !== -1 ? overIndex : activeIndex;

  if (direction === "down" && currentIndex >= 0) {
    const nextItem = currentCell.itemIds.at(currentIndex + 1);
    if (nextItem !== undefined) {
      return nextItem;
    }
  }
  if (direction === "up" && currentIndex > 0) {
    return currentCell.itemIds.at(currentIndex - 1);
  }

  const adjacentCell = getAdjacentCell(cells, currentCell, direction);
  if (adjacentCell === undefined) {
    return undefined;
  }
  if (adjacentCell.itemIds.length === 0) {
    return adjacentCell.id;
  }
  if (direction === "down") {
    return adjacentCell.itemIds.at(0);
  }
  if (direction === "up") {
    return adjacentCell.itemIds.at(-1);
  }
  const targetIndex = Math.max(currentIndex, 0);
  return (
    adjacentCell.itemIds.at(
      Math.min(targetIndex, adjacentCell.itemIds.length - 1),
    ) ?? adjacentCell.id
  );
};

const getDirection = (code: string): NavigationDirection | null => {
  switch (code) {
    case "ArrowDown":
      return "down";
    case "ArrowLeft":
      return "left";
    case "ArrowRight":
      return "right";
    case "ArrowUp":
      return "up";
    default:
      return null;
  }
};

const getCellId = (container: DroppableContainer): UniqueIdentifier | null => {
  const data: unknown = container.data.current;
  if (isKanbanCellDropData(data)) {
    return container.id;
  }
  if (!isKanbanItemDropData(data)) {
    return null;
  }
  return getSortableData(data)?.containerId ?? null;
};

/** Ordered two-dimensional navigation over item and empty-cell targets. */
export const kanbanKeyboardCoordinates: KeyboardCoordinateGetter = (
  event,
  { active, context },
) => {
  const direction = getDirection(event.code);
  if (direction === null) {
    return undefined;
  }
  event.preventDefault();

  const enabledContainers = context.droppableContainers.getEnabled();
  const cellContainers = enabledContainers.filter(({ data }) => {
    const value: unknown = data.current;
    return isKanbanCellDropData(value);
  });
  const cells = cellContainers.flatMap((container): NavigationCell[] => {
    const data: unknown = container.data.current;
    return isKanbanCellDropData(data) ? [{ ...data, id: container.id }] : [];
  });
  const activeData: unknown = context.active?.data.current;
  const keyboardTarget = getKanbanKeyboardTargetState(activeData);
  const overId =
    keyboardTarget?.type === "ready"
      ? keyboardTarget.targetId
      : (context.over?.id ?? active);
  const overContainer = context.droppableContainers.get(overId);
  const activeContainer = context.droppableContainers.get(active);
  const currentCellId =
    (overContainer && getCellId(overContainer)) ??
    (activeContainer && getCellId(activeContainer));
  if (currentCellId === null || currentCellId === undefined) {
    return undefined;
  }

  const targetId = getKanbanKeyboardTarget({
    activeId: active,
    cells,
    currentCellId,
    currentOverId: overId,
    direction,
  });
  if (targetId === undefined) {
    return undefined;
  }
  const targetContainer = context.droppableContainers.get(targetId);
  const targetNode = targetContainer?.node.current;
  if (targetNode === null || targetNode === undefined) {
    const targetCell = cells.find(({ itemIds }) => itemIds.includes(targetId));
    if (
      isKanbanItemDropData(activeData) &&
      targetCell?.navigation.type === "virtual"
    ) {
      activeData.navigation.current = {
        targetId,
        type: "pending",
      };
      targetCell.navigation.requestScroll({ itemId: targetId, type: "item" });
    }
    return undefined;
  }
  const targetRect = context.droppableRects.get(targetId);
  if (targetRect === undefined) {
    return undefined;
  }
  if (isKanbanItemDropData(activeData)) {
    activeData.navigation.current = { targetId, type: "ready" };
  }
  // Commit the collision target before scrolling changes virtual measurements.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      targetNode.scrollIntoView({
        behavior: "instant",
        block: "nearest",
        inline: "nearest",
      });
    });
  });
  return { x: targetRect.left, y: targetRect.top };
};
