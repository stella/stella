"use client";

import * as React from "react";
import { createPortal } from "react-dom";

import {
  AutoScrollActivator,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type {
  AutoScrollOptions,
  CollisionDetection,
  DragCancelEvent,
  DragEndEvent,
  DragOverlayProps,
  DragOverEvent,
  DragStartEvent,
  DndContextProps,
  KeyboardCoordinateGetter,
  KeyboardSensorOptions,
  SensorInstance,
  SensorProps,
  TouchSensorOptions,
  UniqueIdentifier,
} from "@dnd-kit/core";
import { SortableContext, useSortable } from "@dnd-kit/sortable";
import type { SortableContextProps } from "@dnd-kit/sortable";
import { GripVerticalIcon } from "lucide-react";

import { Button } from "../components/button";
import { BOARD_DRAG_OVERLAY_Z_INDEX } from "../lib/overlay-layer";
import { cn } from "../lib/utils";
import {
  clearKanbanKeyboardTarget,
  getKanbanKeyboardTargetState,
  KANBAN_BOARD_COLLISION_DETECTION,
  KANBAN_DROP_TARGET_TYPES,
  kanbanKeyboardCoordinates,
  type KanbanCellDropData,
  type KanbanCellVirtualNavigation,
  type KanbanItemDropData,
  type KanbanSortableCellPosition,
} from "./sortable-interactions.logic";
import { isActiveTouchChange } from "./touch-identity";

export type {
  KanbanCellVirtualNavigation,
  KanbanVirtualScrollRequest,
} from "./sortable-interactions.logic";

export {
  KANBAN_BOARD_COLLISION_DETECTION,
  kanbanKeyboardCoordinates,
} from "./sortable-interactions.logic";
export type { KanbanSortableCellPosition } from "./sortable-interactions.logic";

export const KANBAN_MOUSE_ACTIVATION_DISTANCE = 8;

/** Above sticky board chrome, below app-level floating surfaces. */
export const KANBAN_DRAG_OVERLAY_Z_INDEX = BOARD_DRAG_OVERLAY_Z_INDEX;

export const KANBAN_BOARD_AUTO_SCROLL_OPTIONS = {
  acceleration: 10,
  activator: AutoScrollActivator.Pointer,
  threshold: { x: 0.15, y: 0.15 },
} as const satisfies AutoScrollOptions;

export const KANBAN_SORTABLE_ACTIVATION_MODES = {
  HANDLE: "handle",
  ITEM: "item",
} as const;

export const KANBAN_TOUCH_ACTIVATION_CONSTRAINT = {
  delay: 150,
  tolerance: 8,
} as const;

export type KanbanDragCancelEvent = DragCancelEvent;
export type KanbanDragEndEvent = DragEndEvent;
export type KanbanDragOverEvent = DragOverEvent;
export type KanbanDragStartEvent = DragStartEvent;

type TouchSensorConstructorOptions = SensorProps<TouchSensorOptions>;
type KeyboardSensorConstructorOptions = SensorProps<KeyboardSensorOptions>;

const KANBAN_KEYBOARD_CODES = {
  cancel: ["Escape"],
  end: ["Space", "Enter", "Tab"],
} as const;
const KANBAN_KEYBOARD_LISTENER_DELAY_MS = 0;
const KANBAN_KEYBOARD_TARGET_RETRY_LIMIT = 60;

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

  constructor(props: TouchSensorConstructorOptions) {
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

/**
 * Applies board coordinates without the stock sensor's one-dimensional source
 * scroll clamping. The coordinate getter moves to the typed target and then
 * scrolls that virtual item into view.
 */
class KanbanKeyboardSensor implements SensorInstance {
  static activators = KeyboardSensor.activators;

  autoScrollEnabled = false;

  private readonly listeners = new AbortController();
  private readonly props: KeyboardSensorConstructorOptions;
  private moveSequence = 0;
  private referenceCoordinates: { x: number; y: number } | null = null;

  constructor(props: KeyboardSensorConstructorOptions) {
    this.props = props;
    props.onStart({ x: 0, y: 0 });
    const ownerDocument = getTouchDocument(props.event);
    ownerDocument.addEventListener("visibilitychange", this.handleCancel, {
      signal: this.listeners.signal,
    });
    ownerDocument.defaultView?.addEventListener("resize", this.handleCancel, {
      signal: this.listeners.signal,
    });
    setTimeout(() => {
      if (this.listeners.signal.aborted) {
        return;
      }
      ownerDocument.addEventListener("keydown", this.handleKeyDown, {
        signal: this.listeners.signal,
      });
    }, KANBAN_KEYBOARD_LISTENER_DELAY_MS);
  }

  private readonly handleCancel = () => {
    if (this.listeners.signal.aborted) {
      return;
    }
    this.moveSequence += 1;
    clearKanbanKeyboardTarget(this.props.context.current.active?.data.current);
    this.listeners.abort();
    this.props.onCancel();
  };

  private readonly handleKeyDown = (event: KeyboardEvent) => {
    const keyboardCodes = this.props.options.keyboardCodes;
    const cancelCodes = keyboardCodes?.cancel ?? KANBAN_KEYBOARD_CODES.cancel;
    const endCodes = keyboardCodes?.end ?? KANBAN_KEYBOARD_CODES.end;
    if (cancelCodes.some((code) => code === event.code)) {
      event.preventDefault();
      this.handleCancel();
      return;
    }
    if (endCodes.some((code) => code === event.code)) {
      event.preventDefault();
      this.moveSequence += 1;
      clearKanbanKeyboardTarget(
        this.props.context.current.active?.data.current,
      );
      this.listeners.abort();
      this.props.onEnd();
      return;
    }

    this.moveSequence += 1;
    this.move(event, this.moveSequence, 0);
  };

  private readonly move = (
    event: KeyboardEvent,
    sequence: number,
    retryCount: number,
  ) => {
    const currentContext = this.props.context.current;
    const collisionRect = currentContext.collisionRect;
    const currentCoordinates = collisionRect
      ? { x: collisionRect.left, y: collisionRect.top }
      : { x: 0, y: 0 };
    this.referenceCoordinates ??= currentCoordinates;
    const coordinates = this.props.options.coordinateGetter?.(event, {
      active: this.props.active,
      context: currentContext,
      currentCoordinates,
    });
    if (coordinates === undefined) {
      if (
        getKanbanKeyboardTargetState(currentContext.active?.data.current)
          ?.type !== "pending"
      ) {
        return;
      }
      if (retryCount >= KANBAN_KEYBOARD_TARGET_RETRY_LIMIT) {
        clearKanbanKeyboardTarget(currentContext.active?.data.current);
        return;
      }
      requestAnimationFrame(() => {
        if (this.listeners.signal.aborted || this.moveSequence !== sequence) {
          return;
        }
        this.move(event, sequence, retryCount + 1);
      });
      return;
    }
    this.props.onMove({
      x: coordinates.x - this.referenceCoordinates.x,
      y: coordinates.y - this.referenceCoordinates.y,
    });
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
  onDragEnd: (event: KanbanDragEndEvent) => void;
  collisionDetection?: CollisionDetection | undefined;
  keyboardCoordinates?: KeyboardCoordinateGetter | undefined;
  autoScroll?: boolean | AutoScrollOptions | undefined;
  /** Replaces the default mouse, touch, and keyboard sensors when supplied. */
  sensors?: DndContextProps["sensors"] | undefined;
  /** Overrides dnd-kit's screen-reader announcements when supplied. */
  accessibility?: DndContextProps["accessibility"] | undefined;
  onDragStart?: ((event: KanbanDragStartEvent) => void) | undefined;
  onDragOver?: ((event: KanbanDragOverEvent) => void) | undefined;
  onDragCancel?: ((event: KanbanDragCancelEvent) => void) | undefined;
  /** Rendered in document.body while an item is active. */
  overlay?:
    | ((activeId: UniqueIdentifier | null) => React.ReactNode)
    | undefined;
  overlayProps?: Omit<DragOverlayProps, "children"> | undefined;
};

export type UseKanbanDropTargetOptions = {
  disabled?: boolean | undefined;
  id: string;
  itemIds: readonly UniqueIdentifier[];
  navigation: KanbanCellVirtualNavigation;
  position: KanbanSortableCellPosition;
};

/**
 * Register a board-level drop target such as an empty cell or terminal lane.
 *
 * Board consumers should not need to couple their presentation code to the
 * underlying drag-and-drop library just to receive an item from a sortable
 * context.
 */
export const useKanbanDropTarget = ({
  disabled,
  id,
  itemIds,
  navigation,
  position,
}: UseKanbanDropTargetOptions) => {
  const dropTarget = useDroppable({
    data: {
      itemIds,
      navigation,
      position,
      type: KANBAN_DROP_TARGET_TYPES.CELL,
    } satisfies KanbanCellDropData,
    ...(disabled === undefined ? {} : { disabled }),
    id,
  });

  return {
    isOver: dropTarget.isOver,
    setNodeRef: dropTarget.setNodeRef,
  };
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
  onDragOver,
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
      autoScroll={autoScroll ?? KANBAN_BOARD_AUTO_SCROLL_OPTIONS}
      {...(accessibility === undefined ? {} : { accessibility })}
      collisionDetection={
        collisionDetection ?? KANBAN_BOARD_COLLISION_DETECTION
      }
      onDragCancel={handleDragCancel}
      onDragEnd={handleDragEnd}
      {...(onDragOver === undefined ? {} : { onDragOver })}
      onDragStart={handleDragStart}
      sensors={sensors ?? defaultSensors}
    >
      {children}
      {overlay && typeof document !== "undefined"
        ? createPortal(
            <DragOverlay
              {...overlayProps}
              zIndex={overlayProps?.zIndex ?? KANBAN_DRAG_OVERLAY_Z_INDEX}
            >
              {overlay(activeId)}
            </DragOverlay>,
            document.body,
          )
        : null}
    </DndContext>
  );
};

export const useKanbanSortableSensors = (
  keyboardCoordinates: KeyboardCoordinateGetter = kanbanKeyboardCoordinates,
) =>
  useSensors(
    useSensor(MouseSensor, {
      activationConstraint: { distance: KANBAN_MOUSE_ACTIVATION_DISTANCE },
    }),
    useSensor(KanbanTouchSensor, {
      activationConstraint: KANBAN_TOUCH_ACTIVATION_CONSTRAINT,
    }),
    useSensor(KanbanKeyboardSensor, { coordinateGetter: keyboardCoordinates }),
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

export type KanbanSortableActivationMode =
  | { type: "handle" }
  | { type: "item" };

export type UseKanbanSortableOptions = {
  activation: KanbanSortableActivationMode;
  id: UniqueIdentifier;
  disabled?: boolean | undefined;
};

/**
 * Connect a sortable item and its separate drag handle without making the
 * item's content a touch-none activation surface.
 */
export const useKanbanSortable = ({
  activation,
  id,
  disabled,
}: UseKanbanSortableOptions) => {
  // useSortable merges custom data into a new object after virtualizer renders.
  // The stable nested holder preserves the current navigation branch.
  const data = React.useMemo(
    () =>
      ({
        navigation: { current: { type: "idle" } },
        type: KANBAN_DROP_TARGET_TYPES.ITEM,
      }) satisfies KanbanItemDropData,
    [],
  );
  const sortable = useSortable({
    data,
    id,
    ...(disabled === undefined ? {} : { disabled }),
  });

  const setNodeRef = (element: HTMLElement | null) => {
    sortable.setNodeRef(element);
    if (activation.type === KANBAN_SORTABLE_ACTIVATION_MODES.ITEM) {
      sortable.setActivatorNodeRef(element);
    }
  };

  const bindings = {
    attributes: sortable.attributes,
    listeners: sortable.listeners,
    setActivatorNodeRef: sortable.setActivatorNodeRef,
  };

  const activator =
    activation.type === KANBAN_SORTABLE_ACTIVATION_MODES.HANDLE
      ? { bindings, type: KANBAN_SORTABLE_ACTIVATION_MODES.HANDLE }
      : {
          attributes: sortable.attributes,
          listeners: sortable.listeners,
          type: KANBAN_SORTABLE_ACTIVATION_MODES.ITEM,
        };

  return {
    activator,
    isDragging: sortable.isDragging,
    setNodeRef,
    style: {
      touchAction:
        activation.type === KANBAN_SORTABLE_ACTIVATION_MODES.ITEM
          ? "none"
          : undefined,
      transform: sortable.transform
        ? `translate3d(${sortable.transform.x}px, ${sortable.transform.y}px, 0)`
        : undefined,
      transition: sortable.transition,
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
    className={cn("size-11 min-h-11 min-w-11 touch-none sm:size-11", className)}
    ref={(element) => bindings.setActivatorNodeRef(element)}
    size="icon-xl"
    tooltip={false}
    type="button"
    variant="ghost"
  >
    <GripVerticalIcon aria-hidden="true" />
  </Button>
);
