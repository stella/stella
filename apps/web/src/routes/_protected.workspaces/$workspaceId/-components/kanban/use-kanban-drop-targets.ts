import { useState } from "react";
import type { RefObject } from "react";

import {
  attachClosestEdge,
  extractClosestEdge,
} from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge";
import type { Edge } from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge";
import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import {
  draggable,
  dropTargetForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { panic } from "better-result";

import {
  withDragAnnouncementData,
  withDropAnnouncementData,
} from "@/components/drag-and-drop-live-region.logic";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import {
  COLUMN_DRAG_TYPE,
  ENTITY_DRAG_TYPE,
} from "@/lib/workspaces/drag-constants";

/**
 * Which named drop target currently lives on a given element, so a second
 * registration on the same node can be caught instead of silently replacing
 * the first. Keyed by element (not by name) because pragmatic-drag-and-drop's
 * own element adapter keeps exactly one live drop target per element the
 * same way — a `WeakMap<Element, ...>` registry — so a second
 * `dropTargetForElements` call on a node that already has one quietly
 * overwrites it, with no error anywhere. That is exactly how the flat-column
 * card target once went dark: both the card target and the column-reorder
 * target were registered on the column root, and only the second survived.
 */
const liveElementDropTargets = new WeakMap<Element, string>();

/**
 * Whether double-registration on one element should throw. On in local dev
 * and under test so the mistake is caught before it ships; off in
 * production builds so a reader never sees a thrown error for it — the
 * pre-existing "second call silently wins" behaviour is kept there instead.
 */
const isDropTargetRegistryGuarded = (): boolean =>
  import.meta.env.DEV || import.meta.env.NODE_ENV === "test";

type AttachElementDropTargetParams = Parameters<
  typeof dropTargetForElements
>[0] & {
  /** Identifies this target in the conflict error; not sent anywhere. */
  name: string;
};

/**
 * The one place every kanban element drop target must be registered
 * through. Guarded environments throw when `element` already carries a live
 * target rather than letting the registration silently replace it; the
 * returned cleanup un-registers the element regardless of environment so a
 * later, legitimate registration on the same node (a re-render, a different
 * column reusing a recycled node) is never mistaken for a conflict.
 */
export const attachElementDropTarget = ({
  name,
  ...params
}: AttachElementDropTargetParams): (() => void) => {
  const { element } = params;

  if (isDropTargetRegistryGuarded()) {
    const existing = liveElementDropTargets.get(element);
    if (existing !== undefined) {
      panic(
        `Kanban drop target conflict: "${existing}" is already registered on this element. Registering "${name}" on the same element would silently replace it — pragmatic-drag-and-drop keeps only one live drop target per element. Attach each target to a distinct element instead.`,
      );
    }
    liveElementDropTargets.set(element, name);
  }

  const cleanup = dropTargetForElements(params);

  return () => {
    cleanup();
    if (liveElementDropTargets.get(element) === name) {
      liveElementDropTargets.delete(element);
    }
  };
};

/**
 * The dragged card's source subgroup lane, read from the drag payload.
 * `undefined` means the payload carried no lane at all (a flat board, or a
 * card that never declared one) — distinct from `null`, the Unassigned
 * lane, which is a real source value a caller must not discard.
 */
export const readSourceSubgroupValue = (
  data: Record<string, unknown>,
): string | null | undefined => {
  const raw = data["subgroupValue"];
  if (typeof raw === "string") {
    return raw;
  }
  return raw === null ? null : undefined;
};

type UseKanbanEntityDropTargetParams<TElement extends HTMLElement> = {
  elementRef: RefObject<TElement | null>;
  enabled?: boolean;
  name: string;
  onDrop: (
    entityId: string,
    sourceSubgroupValue: string | null | undefined,
  ) => void;
};

/** One card drop contract for flat columns and subgroup cells. */
export const useKanbanEntityDropTarget = <TElement extends HTMLElement>({
  elementRef,
  enabled = true,
  name,
  onDrop,
}: UseKanbanEntityDropTargetParams<TElement>): boolean => {
  const [isDragOver, setIsDragOver] = useState(false);
  const handleDrop = useLatestCallback(onDrop);

  useExternalSyncEffect(() => {
    const element = elementRef.current;
    if (!element || !enabled) {
      return undefined;
    }

    return attachElementDropTarget({
      element,
      name,
      canDrop: ({ source }) => source.data["type"] === ENTITY_DRAG_TYPE,
      getData: () => withDropAnnouncementData({}, { type: "container", name }),
      onDragEnter: () => setIsDragOver(true),
      onDragLeave: () => setIsDragOver(false),
      onDrop: ({ source }) => {
        setIsDragOver(false);
        const entityId = source.data["entityId"];
        if (typeof entityId === "string") {
          handleDrop(entityId, readSourceSubgroupValue(source.data));
        }
      },
    });
  }, [elementRef, enabled, handleDrop, name]);

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
