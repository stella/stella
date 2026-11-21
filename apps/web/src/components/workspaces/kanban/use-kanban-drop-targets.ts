import { useState } from "react";
import type { RefObject } from "react";

import { attachClosestEdge } from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge/attach-closest-edge";
import { extractClosestEdge } from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge/extract-closest-edge";
import type { Edge } from "@atlaskit/pragmatic-drag-and-drop-hitbox/types";
import { combine } from "@atlaskit/pragmatic-drag-and-drop/utils/combine";

import {
  withDragAnnouncementData,
  withDropAnnouncementData,
} from "@/components/drag-and-drop-live-region.logic";
import { readKanbanDraggedCards } from "@/components/workspaces/kanban/kanban-selection.logic";
import type { KanbanDraggedCard } from "@/components/workspaces/kanban/kanban-selection.logic";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import {
  draggable,
  dropTargetForElements,
} from "@/lib/drag-and-drop/element-registration";
import {
  COLUMN_DRAG_TYPE,
  ENTITY_DRAG_TYPE,
} from "@/lib/workspaces/drag-constants";

export const attachElementDropTarget = dropTargetForElements;

type UseKanbanEntityDropTargetParams<TElement extends HTMLElement> = {
  elementRef: RefObject<TElement | null>;
  enabled?: boolean;
  name: string;
  /** Asked per card; a drag is accepted only when every card it carries is. */
  canDrop?: ((card: KanbanDraggedCard) => boolean) | undefined;
  /** Every card the drag carries: the selection, or the one card. */
  onDrop: (cards: readonly KanbanDraggedCard[]) => void;
};

/** One card drop contract for flat columns and subgroup cells. */
export const useKanbanEntityDropTarget = <TElement extends HTMLElement>({
  elementRef,
  enabled = true,
  name,
  canDrop,
  onDrop,
}: UseKanbanEntityDropTargetParams<TElement>): boolean => {
  const [isDragOver, setIsDragOver] = useState(false);
  const handleDrop = useLatestCallback(onDrop);
  const acceptsDrop = useLatestCallback(
    (cards: readonly KanbanDraggedCard[]) =>
      cards.length > 0 && (canDrop === undefined || cards.every(canDrop)),
  );

  useExternalSyncEffect(() => {
    const element = elementRef.current;
    if (!element || !enabled) {
      return undefined;
    }

    return attachElementDropTarget({
      element,
      name,
      canDrop: ({ source }) =>
        source.data["type"] === ENTITY_DRAG_TYPE &&
        acceptsDrop(readKanbanDraggedCards(source.data)),
      getData: () => withDropAnnouncementData({}, { type: "container", name }),
      onDragEnter: () => setIsDragOver(true),
      onDragLeave: () => setIsDragOver(false),
      onDrop: ({ source }) => {
        setIsDragOver(false);
        const cards = readKanbanDraggedCards(source.data);
        if (cards.length > 0) {
          handleDrop(cards);
        }
      },
    });
  }, [acceptsDrop, elementRef, enabled, handleDrop, name]);

  return isDragOver;
};

type UseKanbanColumnDragParams<TElement extends HTMLElement> = {
  columnValue: string | null;
  dragHandleRef: RefObject<HTMLElement | null>;
  elementRef: RefObject<TElement | null>;
  name: string;
  onDrop?:
    | ((sourceValue: string, targetValue: string, edge: Edge | null) => void)
    | undefined;
  reorderEnabled: boolean;
};

type KanbanColumnDragState = {
  closestEdge: Edge | null;
  isDragging: boolean;
};

/** One primary-column reorder contract for flat and subgrouped boards. */
export const useKanbanColumnDrag = <TElement extends HTMLElement>({
  columnValue,
  dragHandleRef,
  elementRef,
  name,
  onDrop,
  reorderEnabled,
}: UseKanbanColumnDragParams<TElement>): KanbanColumnDragState => {
  const [isDragging, setIsDragging] = useState(false);
  const [closestEdge, setClosestEdge] = useState<Edge | null>(null);
  const handleDrop = useLatestCallback(
    (sourceValue: string, targetValue: string, edge: Edge | null) =>
      onDrop?.(sourceValue, targetValue, edge),
  );

  useExternalSyncEffect(() => {
    const element = elementRef.current;
    const dragHandle = dragHandleRef.current;
    if (!element || !dragHandle || !reorderEnabled || columnValue === null) {
      return undefined;
    }

    return combine(
      attachElementDropTarget({
        element,
        name,
        canDrop: ({ source }) =>
          source.data["type"] === COLUMN_DRAG_TYPE &&
          source.data["columnValue"] !== columnValue,
        getData: ({ input, element: targetElement }) =>
          attachClosestEdge(
            withDropAnnouncementData(
              { columnValue },
              { type: "reorder", name },
            ),
            {
              input,
              element: targetElement,
              allowedEdges: ["left", "right"],
            },
          ),
        onDragEnter: ({ self }) =>
          setClosestEdge(extractClosestEdge(self.data)),
        onDrag: ({ self }) => {
          const edge = extractClosestEdge(self.data);
          setClosestEdge((current) => (current === edge ? current : edge));
        },
        onDragLeave: () => setClosestEdge(null),
        onDrop: ({ source, self }) => {
          const sourceValue = source.data["columnValue"];
          const edge = extractClosestEdge(self.data);
          setClosestEdge(null);
          if (typeof sourceValue === "string") {
            handleDrop(sourceValue, columnValue, edge);
          }
        },
      }),
      draggable({
        element,
        dragHandle,
        getInitialData: () =>
          withDragAnnouncementData(
            { type: COLUMN_DRAG_TYPE, columnValue },
            name,
          ),
        onDragStart: () => setIsDragging(true),
        onDrop: () => setIsDragging(false),
      }),
    );
  }, [
    columnValue,
    dragHandleRef,
    elementRef,
    handleDrop,
    name,
    reorderEnabled,
  ]);

  return { closestEdge, isDragging };
};
