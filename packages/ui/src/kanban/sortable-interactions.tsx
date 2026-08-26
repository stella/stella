"use client";

import * as React from "react";

import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type {
  AutoScrollOptions,
  CollisionDetection,
  DragCancelEvent,
  DragEndEvent,
  DragOverlayProps,
  DragStartEvent,
  DndContextProps,
  KeyboardCoordinateGetter,
  UniqueIdentifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import type { SortableContextProps } from "@dnd-kit/sortable";
import { GripVerticalIcon } from "lucide-react";

import { Button } from "../components/button";
import { cn } from "../lib/utils";

export const KANBAN_MOUSE_ACTIVATION_DISTANCE = 8;

export const KANBAN_TOUCH_ACTIVATION_CONSTRAINT = {
  delay: 150,
  tolerance: 8,
} as const;

export type KanbanSortableBoardProps = {
  children: React.ReactNode;
  onDragEnd: (event: DragEndEvent) => void;
  collisionDetection?: CollisionDetection | undefined;
  keyboardCoordinates?: KeyboardCoordinateGetter | undefined;
  autoScroll?: boolean | AutoScrollOptions | undefined;
  /** Replaces the default mouse, touch, and keyboard sensors when supplied. */
  sensors?: DndContextProps["sensors"] | undefined;
  /** Overrides dnd-kit's screen-reader announcements when supplied. */
  accessibility?: DndContextProps["accessibility"] | undefined;
  onDragStart?: ((event: DragStartEvent) => void) | undefined;
  onDragCancel?: ((event: DragCancelEvent) => void) | undefined;
  /** Rendered inside dnd-kit's portal while an item is active. */
  overlay?:
    | ((activeId: UniqueIdentifier | null) => React.ReactNode)
    | undefined;
  overlayProps?: Omit<DragOverlayProps, "children"> | undefined;
};

/**
 * Input-complete drag context for sortable boards.
 *
 * The consumer owns identifiers and the result of a drop; this component owns
 * the sensor activation rules, keyboard navigation, auto-scroll configuration,
 * and overlay lifecycle shared by sortable board UIs.
 */
export const KanbanSortableBoard = ({
  children,
  onDragEnd,
  collisionDetection,
  keyboardCoordinates,
  autoScroll,
  sensors,
  accessibility,
  onDragStart,
  onDragCancel,
  overlay,
  overlayProps,
}: KanbanSortableBoardProps) => {
  const [activeId, setActiveId] = React.useState<UniqueIdentifier | null>(null);
  const defaultSensors = useKanbanSortableSensors(keyboardCoordinates);

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id);
    onDragStart?.(event);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveId(null);
    onDragEnd(event);
  };

  const handleDragCancel = (event: DragCancelEvent) => {
    setActiveId(null);
    onDragCancel?.(event);
  };

  return (
    <DndContext
      {...(autoScroll === undefined ? {} : { autoScroll })}
      {...(accessibility === undefined ? {} : { accessibility })}
      {...(collisionDetection === undefined ? {} : { collisionDetection })}
      onDragCancel={handleDragCancel}
      onDragEnd={handleDragEnd}
      onDragStart={handleDragStart}
      sensors={sensors ?? defaultSensors}
    >
      {children}
      {overlay && (
        <DragOverlay {...overlayProps}>{overlay(activeId)}</DragOverlay>
      )}
    </DndContext>
  );
};

export const useKanbanSortableSensors = (
  keyboardCoordinates: KeyboardCoordinateGetter = sortableKeyboardCoordinates,
) =>
  useSensors(
    useSensor(MouseSensor, {
      activationConstraint: { distance: KANBAN_MOUSE_ACTIVATION_DISTANCE },
    }),
    useSensor(TouchSensor, {
      activationConstraint: KANBAN_TOUCH_ACTIVATION_CONSTRAINT,
    }),
    useSensor(KeyboardSensor, { coordinateGetter: keyboardCoordinates }),
  );

export type KanbanSortableListProps = SortableContextProps &
  React.ComponentProps<"div">;

/** A vertical card list that preserves native vertical touch scrolling. */
export const KanbanSortableList = ({
  className,
  children,
  id,
  items,
  strategy,
  disabled,
  ...props
}: KanbanSortableListProps) => (
  <SortableContext
    {...(disabled === undefined ? {} : { disabled })}
    {...(id === undefined ? {} : { id })}
    items={items}
    {...(strategy === undefined ? {} : { strategy })}
  >
    <div
      className={cn(
        "min-h-0 touch-auto overflow-y-auto overscroll-y-contain",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  </SortableContext>
);

export type KanbanSortableColumnsProps = SortableContextProps &
  React.ComponentProps<"div">;

/** A horizontal column list that keeps the board pan gesture available. */
export const KanbanSortableColumns = ({
  className,
  children,
  id,
  items,
  strategy,
  disabled,
  ...props
}: KanbanSortableColumnsProps) => (
  <SortableContext
    {...(disabled === undefined ? {} : { disabled })}
    {...(id === undefined ? {} : { id })}
    items={items}
    {...(strategy === undefined ? {} : { strategy })}
  >
    <div
      className={cn(
        "flex min-h-0 touch-auto overflow-x-auto overscroll-x-contain",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  </SortableContext>
);

export type KanbanSortableBindings = Pick<
  ReturnType<typeof useSortable>,
  "attributes" | "listeners" | "setActivatorNodeRef"
>;

export type UseKanbanSortableOptions = {
  id: UniqueIdentifier;
  disabled?: boolean | undefined;
};

/**
 * Connect a sortable item and its separate drag handle without making the
 * item's content a touch-none activation surface.
 */
export const useKanbanSortable = ({
  id,
  disabled,
}: UseKanbanSortableOptions) => {
  const sortable = useSortable({
    id,
    ...(disabled === undefined ? {} : { disabled }),
  });

  return {
    isDragging: sortable.isDragging,
    setNodeRef: sortable.setNodeRef,
    style: {
      transform: sortable.transform
        ? `translate3d(${sortable.transform.x}px, ${sortable.transform.y}px, 0)`
        : undefined,
      transition: sortable.transition,
    },
    dragHandle: {
      attributes: sortable.attributes,
      listeners: sortable.listeners,
      setActivatorNodeRef: sortable.setActivatorNodeRef,
    },
  };
};

export type KanbanDragHandleProps = {
  bindings: KanbanSortableBindings;
  label: string;
} & Omit<
  React.ComponentProps<typeof Button>,
  "aria-label" | "children" | "ref" | "tooltip" | "type"
>;

/**
 * A 44px keyboard-accessible drag activator. The handle is the only board
 * surface that disables touch panning, leaving cards and scroll regions free
 * for ordinary scrolling.
 */
export const KanbanDragHandle = ({
  bindings,
  label,
  className,
  ...props
}: KanbanDragHandleProps) => (
  <Button
    {...props}
    {...bindings.attributes}
    {...bindings.listeners}
    aria-label={label}
    className={cn("size-11 touch-none sm:size-11", className)}
    ref={(element) => bindings.setActivatorNodeRef(element)}
    size="icon-xl"
    tooltip={false}
    type="button"
    variant="ghost"
  >
    <GripVerticalIcon aria-hidden="true" />
  </Button>
);
