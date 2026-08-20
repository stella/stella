import { autoScrollForElements } from "@atlaskit/pragmatic-drag-and-drop-auto-scroll/dist/cjs/entry-point/element.js";
import { autoScrollForExternal } from "@atlaskit/pragmatic-drag-and-drop-auto-scroll/dist/cjs/entry-point/external.js";
import { combine } from "@atlaskit/pragmatic-drag-and-drop/dist/cjs/entry-point/combine.js";
import {
  draggable,
  dropTargetForElements,
  monitorForElements,
} from "@atlaskit/pragmatic-drag-and-drop/dist/cjs/entry-point/element/adapter.js";
import { centerUnderPointer } from "@atlaskit/pragmatic-drag-and-drop/dist/cjs/entry-point/element/center-under-pointer.js";
import { setCustomNativeDragPreview } from "@atlaskit/pragmatic-drag-and-drop/dist/cjs/entry-point/element/set-custom-native-drag-preview.js";

export type RegisterKanbanCardDragOptions = {
  /** The drag wrapper rendered by `KanbanCardShell`. */
  element: HTMLElement;
  /** Domain data read by the board's drop monitor. */
  getInitialData: () => Record<string | symbol, unknown>;
  /** Omit when every rendered card may move. */
  canDrag?: (() => boolean) | undefined;
  onDragStart?: (() => void) | undefined;
  onDrop?: (() => void) | undefined;
};

/**
 * Register every kanban element against the package's shared drag adapter.
 *
 * Drag sources, drop targets, and monitors must use these exports together.
 * Mixing module formats creates separate adapter registries in some bundlers.
 */
export const registerKanbanDraggable: typeof draggable = (options) =>
  draggable(options);

export const registerKanbanDropTarget: typeof dropTargetForElements = (
  options,
) => dropTargetForElements(options);

export const monitorKanbanDrags: typeof monitorForElements = (options) =>
  monitorForElements(options);

/**
 * Register the standard kanban card drag source and native preview.
 *
 * Movement remains with the caller: the package does not inspect the drag data
 * or persist a drop. It owns the interaction every card shares, including a
 * pointer-centred preview cloned from the styled card inside the shell.
 */
export const registerKanbanCardDrag = ({
  element,
  getInitialData,
  canDrag,
  onDragStart,
  onDrop,
}: RegisterKanbanCardDragOptions): (() => void) =>
  registerKanbanDraggable({
    element,
    getInitialData,
    ...(canDrag === undefined ? {} : { canDrag }),
    ...(onDragStart === undefined ? {} : { onDragStart }),
    ...(onDrop === undefined ? {} : { onDrop }),
    onGenerateDragPreview: ({ nativeSetDragImage }) => {
      setCustomNativeDragPreview({
        nativeSetDragImage,
        getOffset: centerUnderPointer,
        render: ({ container }) => {
          const card = element.firstElementChild;
          if (!(card instanceof HTMLElement)) {
            return;
          }
          const clone = card.cloneNode(true);
          if (!(clone instanceof HTMLElement)) {
            return;
          }
          clone.style.width = `${card.getBoundingClientRect().width}px`;
          container.append(clone);
        },
      });
    },
  });

export const KANBAN_BOARD_AUTO_SCROLL_SOURCES = {
  elements: "elements",
  elementsAndExternal: "elements-and-external",
} as const;

type KanbanBoardAutoScrollSource =
  (typeof KANBAN_BOARD_AUTO_SCROLL_SOURCES)[keyof typeof KANBAN_BOARD_AUTO_SCROLL_SOURCES];

export type RegisterKanbanBoardAutoScrollOptions = {
  element: HTMLElement;
  /** External sources include files dragged in from outside the page. */
  sources: KanbanBoardAutoScrollSource;
};

/** Register horizontal auto-scroll at the board's overflow boundary. */
export const registerKanbanBoardAutoScroll = ({
  element,
  sources,
}: RegisterKanbanBoardAutoScrollOptions): (() => void) => {
  const elementCleanup = autoScrollForElements({
    element,
    getAllowedAxis: () => "horizontal",
  });
  if (sources === KANBAN_BOARD_AUTO_SCROLL_SOURCES.elements) {
    return elementCleanup;
  }
  return combine(
    elementCleanup,
    autoScrollForExternal({
      element,
      getAllowedAxis: () => "horizontal",
    }),
  );
};
