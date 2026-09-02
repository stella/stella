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
  MouseSensorOptions,
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
  isKanbanDropSettled,
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
  CARD: "card",
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

type MouseSensorConstructorOptions = SensorProps<MouseSensorOptions>;
type TouchSensorConstructorOptions = SensorProps<TouchSensorOptions>;
type KeyboardSensorConstructorOptions = SensorProps<KeyboardSensorOptions>;
type KanbanSensorContext = SensorProps<never>["context"];

const KANBAN_KEYBOARD_CODES = {
  cancel: ["Escape"],
  end: ["Space", "Enter", "Tab"],
} as const;
const KANBAN_KEYBOARD_TARGET_RETRY_LIMIT = 60;
/** A render commit, not a virtual scroll, so the budget stays short. */
const KANBAN_DROP_SETTLE_FRAME_LIMIT = 10;

/**
 * Defers a drop until dnd-kit has published the collision target it computed.
 * Every sensor ends a drag from a single input event, so without this wait the
 * drop resolves against the target published before that event.
 */
const endWhenDropTargetSettled = (
  context: KanbanSensorContext,
  end: () => void,
) => {
  let framesWaited = 0;
  const attempt = () => {
    if (
      framesWaited >= KANBAN_DROP_SETTLE_FRAME_LIMIT ||
      isKanbanDropSettled(context.current)
    ) {
      end();
      return;
    }
    framesWaited += 1;
    requestAnimationFrame(attempt);
  };
  attempt();
};

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
        endWhenDropTargetSettled(props.context, () => {
          props.onEnd();
        });
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

/** The stock mouse sensor, holding its drop until the board target settles. */
class KanbanMouseSensor extends MouseSensor {
  constructor(props: MouseSensorConstructorOptions) {
    super({
      ...props,
      onEnd: () => {
        endWhenDropTargetSettled(props.context, () => {
          props.onEnd();
        });
      },
    });
  }
}

/**
 * Applies board coordinates without the stock sensor's one-dimensional source
 * scroll clamping. The coordinate getter moves to the typed target and then
 * scrolls that virtual item into view.
 */
class KanbanKeyboardSensor implements SensorInstance {
  static activators = KeyboardSensor.activators;

  autoScrollEnabled = false;

  /** Input handling, released as soon as a drag stops accepting keys. */
  private readonly listeners = new AbortController();
  /**
   * The drag itself, released only once it resolves. Ending must not stop the
   * queued retry that still has to bring a pending virtual target into view.
   */
  private readonly lifetime = new AbortController();
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
    ownerDocument.addEventListener("keydown", this.handleKeyDown, {
      signal: this.listeners.signal,
    });
  }

  private readonly handleCancel = () => {
    if (this.lifetime.signal.aborted) {
      return;
    }
    this.moveSequence += 1;
    this.listeners.abort();
    this.finish(() => {
      this.props.onCancel();
    });
  };

  private readonly finish = (resolve: () => void) => {
    clearKanbanKeyboardTarget(this.props.context.current.active?.data.current);
    this.lifetime.abort();
    resolve();
  };

  private readonly handleKeyDown = (event: KeyboardEvent) => {
    // The sensor can be constructed while the activation key is still
    // bubbling. Ignore that exact native event; distinct keys may share a
    // timestamp in a fast browser session and must never be coalesced.
    if (event === this.props.event) {
      return;
    }
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
      // The move sequence and the lifetime signal stay untouched so a queued
      // virtual-scroll retry can still resolve the target this drop needs.
      this.listeners.abort();
      this.endWhenNavigationResolves(0);
      return;
    }

    this.moveSequence += 1;
    this.move(event, this.moveSequence, 0);
  };

  /**
   * A pending target has asked a virtual cell to mount an offscreen row and has
   * published nothing, so the queued move retry, not this keypress, decides
   * where the item lands. Cancel when that retry gives up: the board never
   * reached the row the user navigated to, and the target still published is
   * the one they navigated away from.
   */
  private readonly endWhenNavigationResolves = (framesWaited: number) => {
    if (this.lifetime.signal.aborted) {
      return;
    }
    const target = getKanbanKeyboardTargetState(
      this.props.context.current.active?.data.current,
    );
    if (target?.type === "pending") {
      if (framesWaited >= KANBAN_KEYBOARD_TARGET_RETRY_LIMIT) {
        this.finish(() => {
          this.props.onCancel();
        });
        return;
      }
      requestAnimationFrame(() => {
        this.endWhenNavigationResolves(framesWaited + 1);
      });
      return;
    }
    if (framesWaited > 0 && target?.type !== "ready") {
      this.finish(() => {
        this.props.onCancel();
      });
      return;
    }
    endWhenDropTargetSettled(this.props.context, () => {
      // The wait is bounded, so it can stop without the board ever publishing
      // the navigated target. Committing whatever is published instead would
      // drop the item somewhere the user never asked for.
      const settled = isKanbanDropSettled(this.props.context.current);
      this.finish(() => {
        if (settled) {
          this.props.onEnd();
          return;
        }
        this.props.onCancel();
      });
    });
  };

  private readonly move = (
    event: KeyboardEvent,
    sequence: number,
    retryCount: number,
  ) => {
    const currentContext = this.props.context.current;
    // onStart enters dnd-kit's React state machine. A key pressed immediately
    // after Space can reach this native listener before that active context is
    // committed. Preserve that real input until the context has registered the
    // active item; processing it earlier would navigate from an incomplete
    // target set and silently drop the key.
    if (currentContext.active?.id !== this.props.active) {
      requestAnimationFrame(() => {
        if (this.listeners.signal.aborted || this.moveSequence !== sequence) {
          return;
        }
        this.move(event, sequence, retryCount);
      });
      return;
    }
    const collisionRect = currentContext.collisionRect;
    const currentCoordinates = collisionRect
      ? { x: collisionRect.left, y: collisionRect.top }
      : { x: 0, y: 0 };
    this.referenceCoordinates ??= currentCoordinates;
    const activeData = currentContext.active.data.current;
    const coordinates = this.props.options.coordinateGetter?.(event, {
      active: this.props.active,
      context: currentContext,
      currentCoordinates,
    });
    if (coordinates === undefined) {
      if (getKanbanKeyboardTargetState(activeData)?.type !== "pending") {
        return;
      }
      if (retryCount >= KANBAN_KEYBOARD_TARGET_RETRY_LIMIT) {
        clearKanbanKeyboardTarget(activeData);
        return;
      }
      requestAnimationFrame(() => {
        if (this.lifetime.signal.aborted || this.moveSequence !== sequence) {
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
  /** Minimum pointer movement before a mouse drag activates. */
  mouseActivationDistance?: number | undefined;
  collisionDetection?: CollisionDetection | undefined;
  keyboardCoordinates?: KeyboardCoordinateGetter | undefined;
  autoScroll?: boolean | AutoScrollOptions | undefined;
  /** Replaces the default mouse, touch, and keyboard sensors when supplied. */
  sensors?: DndContextProps["sensors"] | undefined;
  /** Overrides dnd-kit's screen-reader announcements when supplied. */
  accessibility?: DndContextProps["accessibility"] | undefined;
  /**
   * Fires on drag start and on every drag end or cancel; a board over a
   * `KanbanSubgroupBoard` combines the two into that board's `isDragging`
   * (`true` here, `false` on `onDragEnd`/`onDragCancel`).
   */
  onDragStart?: ((event: KanbanDragStartEvent) => void) | undefined;
  /**
   * Fires whenever dnd-kit's collision detection changes the drop target
   * the drag is over, `event.over` included when it becomes none. A board
   * over a `KanbanSubgroupBoard` maps `event.over?.id ?? null` to a band id
   * (via `KanbanSubgroupCellContext.band`, or a droppable registered for a
   * folded band's slot) to drive that board's `dragOverBandId`.
   */
  onDragOver?: ((event: KanbanDragOverEvent) => void) | undefined;
  onDragCancel?: ((event: KanbanDragCancelEvent) => void) | undefined;
  /** Called once mounted child drop targets can safely receive input. */
  onInteractionReady?: (() => void) | undefined;
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

// Keep sensor descriptors stable while child sortable and virtual-cell effects
// register with dnd-kit. Components used outside a KanbanSortableBoard retain
// their existing behavior through the ready default.
const KanbanInteractionReadinessContext = React.createContext(true);

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
  const interactionReady = React.useContext(KanbanInteractionReadinessContext);
  const dropTarget = useDroppable({
    data: {
      itemIds,
      navigation,
      position,
      type: KANBAN_DROP_TARGET_TYPES.CELL,
    } satisfies KanbanCellDropData,
    disabled: !interactionReady || disabled === true,
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
  mouseActivationDistance,
  collisionDetection,
  keyboardCoordinates,
  autoScroll,
  sensors,
  accessibility,
  onDragStart,
  onDragOver,
  onDragCancel,
  onInteractionReady,
  overlay,
  overlayProps,
}: KanbanSortableBoardProps) => {
  const [activeId, setActiveId] = React.useState<UniqueIdentifier | null>(null);
  const [interactionReady, setInteractionReady] = React.useState(false);
  const interactionReadyNotified = React.useRef(false);
  const defaultSensors = useKanbanSortableSensors(
    keyboardCoordinates,
    mouseActivationDistance,
  );

  // dnd-kit registers child droppables after commit. Keep the sensor list
  // stable, but hold sortable sources and virtual cells disabled until that
  // registration pass has completed.
  React.useEffect(() => {
    const frame = requestAnimationFrame(() => {
      setInteractionReady(true);
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, []);

  React.useEffect(() => {
    if (!interactionReady || interactionReadyNotified.current) {
      return;
    }
    interactionReadyNotified.current = true;
    onInteractionReady?.();
  }, [interactionReady, onInteractionReady]);

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
    <KanbanInteractionReadinessContext value={interactionReady}>
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
    </KanbanInteractionReadinessContext>
  );
};

export const useKanbanSortableSensors = (
  keyboardCoordinates: KeyboardCoordinateGetter = kanbanKeyboardCoordinates,
  mouseActivationDistance: number = KANBAN_MOUSE_ACTIVATION_DISTANCE,
) =>
  useSensors(
    useSensor(KanbanMouseSensor, {
      activationConstraint: { distance: mouseActivationDistance },
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
  | { type: "card" }
  | { type: "handle" }
  | { type: "item" };

export type UseKanbanSortableOptions = {
  activation: KanbanSortableActivationMode;
  id: UniqueIdentifier;
  disabled?: boolean | undefined;
};

type KanbanSortableActivator =
  | {
      bindings: KanbanSortableBindings;
      type: typeof KANBAN_SORTABLE_ACTIVATION_MODES.HANDLE;
    }
  | {
      bindings: KanbanSortableBindings;
      type: typeof KANBAN_SORTABLE_ACTIVATION_MODES.CARD;
    }
  | {
      attributes: ReturnType<typeof useSortable>["attributes"];
      listeners: ReturnType<typeof useSortable>["listeners"];
      type: typeof KANBAN_SORTABLE_ACTIVATION_MODES.ITEM;
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
  const interactionReady = React.useContext(KanbanInteractionReadinessContext);
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
    disabled: !interactionReady || disabled === true,
    id,
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

  let activator: KanbanSortableActivator;
  if (activation.type === KANBAN_SORTABLE_ACTIVATION_MODES.HANDLE) {
    activator = { bindings, type: KANBAN_SORTABLE_ACTIVATION_MODES.HANDLE };
  } else if (activation.type === KANBAN_SORTABLE_ACTIVATION_MODES.CARD) {
    activator = { bindings, type: KANBAN_SORTABLE_ACTIVATION_MODES.CARD };
  } else {
    activator = {
      attributes: sortable.attributes,
      listeners: sortable.listeners,
      type: KANBAN_SORTABLE_ACTIVATION_MODES.ITEM,
    };
  }

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

const KANBAN_CARD_DRAG_SURFACE_INTERACTIVE_SELECTOR =
  "a,button,input,select,textarea,[contenteditable=true],[role=button],[data-kanban-drag-exempt]";

const isKanbanCardDragSurfaceInteractiveTarget = (
  target: EventTarget | null,
  activator: EventTarget | null,
) => {
  if (!(target instanceof Element)) {
    return false;
  }
  const interactiveTarget = target.closest(
    KANBAN_CARD_DRAG_SURFACE_INTERACTIVE_SELECTOR,
  );
  return interactiveTarget !== null && interactiveTarget !== activator;
};

const getKanbanCardDragSurfaceAttributes = ({
  "aria-describedby": _describedBy,
  "aria-disabled": _disabled,
  "aria-pressed": _pressed,
  "aria-roledescription": _roleDescription,
  role: _role,
  tabIndex,
  ...attributes
}: KanbanSortableBindings["attributes"]) => ({ ...attributes, tabIndex });

type KanbanCardDragSurfaceListener = (
  event: React.SyntheticEvent<HTMLDivElement>,
) => void;

const isKanbanCardDragSurfaceListener = (
  listener: unknown,
): listener is KanbanCardDragSurfaceListener => typeof listener === "function";

const getKanbanCardDragSurfaceListeners = (
  listeners: NonNullable<KanbanSortableBindings["listeners"]>,
) => {
  const { onKeyDown, onMouseDown, onPointerDown, onTouchStart, ...rest } =
    listeners;

  const shouldActivate = (event: React.SyntheticEvent<HTMLDivElement>) =>
    !isKanbanCardDragSurfaceInteractiveTarget(
      event.target,
      event.currentTarget,
    );

  return {
    ...rest,
    ...(!isKanbanCardDragSurfaceListener(onKeyDown)
      ? {}
      : {
          onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
            if (shouldActivate(event)) {
              onKeyDown(event);
            }
          },
        }),
    ...(!isKanbanCardDragSurfaceListener(onMouseDown)
      ? {}
      : {
          onMouseDown: (event: React.MouseEvent<HTMLDivElement>) => {
            if (shouldActivate(event)) {
              onMouseDown(event);
            }
          },
        }),
    ...(!isKanbanCardDragSurfaceListener(onPointerDown)
      ? {}
      : {
          onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => {
            if (shouldActivate(event)) {
              onPointerDown(event);
            }
          },
        }),
    ...(!isKanbanCardDragSurfaceListener(onTouchStart)
      ? {}
      : {
          onTouchStart: (event: React.TouchEvent<HTMLDivElement>) => {
            if (shouldActivate(event)) {
              onTouchStart(event);
            }
          },
        }),
  };
};

export type KanbanCardDragSurfaceProps = {
  bindings: KanbanSortableBindings;
} & Omit<React.ComponentProps<"div">, "ref">;

/** A whole-card drag activator that preserves descendant controls and scrolling. */
export const KanbanCardDragSurface = ({
  bindings,
  className,
  ...props
}: KanbanCardDragSurfaceProps) => {
  const { listeners, setActivatorNodeRef: setCardActivatorNodeRef } = bindings;
  const setActivatorNodeRef = React.useCallback(
    (element: HTMLDivElement | null) => {
      setCardActivatorNodeRef(element);
    },
    [setCardActivatorNodeRef],
  );

  return (
    <div
      {...props}
      {...getKanbanCardDragSurfaceAttributes(bindings.attributes)}
      {...(listeners === undefined
        ? {}
        : getKanbanCardDragSurfaceListeners(listeners))}
      className={cn("touch-auto", className)}
      ref={setActivatorNodeRef}
    />
  );
};
