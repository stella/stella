"use client";

import * as React from "react";
import { createPortal } from "react-dom";

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
  SensorProps,
  TouchSensorOptions,
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
import { isActiveTouchChange } from "./touch-identity";

export const KANBAN_MOUSE_ACTIVATION_DISTANCE = 8;

export const KANBAN_TOUCH_ACTIVATION_CONSTRAINT = {
  delay: 150,
  tolerance: 8,
} as const;

type TouchSensorProps = SensorProps<TouchSensorOptions>;

type TouchEventWithLists = Event & {
  changedTouches: TouchList;
  touches: TouchList;
};

const hasTouchLists = (event: Event): event is TouchEventWithLists =>
  "changedTouches" in event && "touches" in event;

const getTouchIdentifier = (event: Event): number | null => {
  if (!hasTouchLists(event)) {
    return null;
  }
  return (
    event.changedTouches.item(0)?.identifier ??
    event.touches.item(0)?.identifier ??
    null
  );
};

const getTouchIdentifiers = (touches: TouchList) => {
  const identifiers: number[] = [];
  for (let index = 0; index < touches.length; index += 1) {
    const identifier = touches.item(index)?.identifier;
    if (identifier !== undefined) {
      identifiers.push(identifier);
    }
  }
  return identifiers;
};

/**
 * Keeps a delayed touch drag bound to the finger that activated it.
 *
 * dnd-kit's stock touch sensor attaches document-level lifecycle listeners,
 * so a second finger can otherwise move, end, or cancel the active drag. The
 * capture listeners below suppress only secondary touch changes before those
 * listeners receive them; browser scrolling remains native because no default
 * action is prevented here.
 */
class KanbanTouchSensor extends TouchSensor {
  private readonly identityListeners: AbortController;
  private readonly ownerDocument: Document;
  private readonly touchIdentifier: number | null;

  constructor(props: TouchSensorProps) {
    const identityListeners = new AbortController();
    super({
      ...props,
      onAbort: (active) => {
        identityListeners.abort();
        props.onAbort(active);
      },
      onCancel: () => {
        identityListeners.abort();
        props.onCancel();
      },
      onEnd: () => {
        identityListeners.abort();
        props.onEnd();
      },
    });
    this.identityListeners = identityListeners;
    this.ownerDocument = getTouchDocument(props.event);
    this.touchIdentifier = getTouchIdentifier(props.event);
    this.ownerDocument.addEventListener("touchmove", this.handleTouchMove, {
      capture: true,
      passive: false,
      signal: identityListeners.signal,
    });
    this.ownerDocument.addEventListener("touchend", this.handleTouchEnd, {
      capture: true,
      signal: identityListeners.signal,
    });
    this.ownerDocument.addEventListener("touchcancel", this.handleTouchCancel, {
      capture: true,
      signal: identityListeners.signal,
    });
  }

  private readonly handleTouchMove = (event: TouchEvent) => {
    if (this.isPrimaryTouchChange(event)) {
      return;
    }
    event.stopImmediatePropagation();
  };

  private readonly handleTouchEnd = (event: TouchEvent) => {
    if (!this.isPrimaryTouchChange(event)) {
      event.stopImmediatePropagation();
      return;
    }
    this.detachIdentityListeners();
  };

  private readonly handleTouchCancel = (event: TouchEvent) => {
    if (!this.isPrimaryTouchChange(event)) {
      event.stopImmediatePropagation();
      return;
    }
    this.detachIdentityListeners();
  };

  private readonly isPrimaryTouchChange = (event: TouchEvent) =>
    isActiveTouchChange({
      activeTouchIdentifier: this.touchIdentifier,
      changedTouchIdentifiers: getTouchIdentifiers(event.changedTouches),
    });

  private readonly detachIdentityListeners = () => {
    this.identityListeners.abort();
  };
}

const getTouchDocument = (event: Event): Document => {
  if (event.target instanceof Node && event.target.ownerDocument) {
    return event.target.ownerDocument;
  }
  return document;
};

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
  /** Rendered in document.body while an item is active. */
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
      {overlay && typeof document !== "undefined"
        ? createPortal(
            <DragOverlay {...overlayProps}>{overlay(activeId)}</DragOverlay>,
            document.body,
          )
        : null}
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
    useSensor(KanbanTouchSensor, {
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
