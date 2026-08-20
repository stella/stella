import { autoScrollForElements } from "@atlaskit/pragmatic-drag-and-drop-auto-scroll/element";
import { autoScrollForExternal } from "@atlaskit/pragmatic-drag-and-drop-auto-scroll/external";
import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import { draggable } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { centerUnderPointer } from "@atlaskit/pragmatic-drag-and-drop/element/center-under-pointer";
import { setCustomNativeDragPreview } from "@atlaskit/pragmatic-drag-and-drop/element/set-custom-native-drag-preview";

type AtlaskitDraggableOptions = Parameters<typeof draggable>[0];

export type RegisterKanbanCardDragOptions = {
  /** The drag wrapper rendered by `KanbanCardShell`. */
  element: AtlaskitDraggableOptions["element"];
  /** Domain data read by the board's drop monitor. */
  getInitialData: NonNullable<AtlaskitDraggableOptions["getInitialData"]>;
  /** Omit when every rendered card may move. */
  canDrag?: AtlaskitDraggableOptions["canDrag"];
  onDragStart?: AtlaskitDraggableOptions["onDragStart"];
  onDrop?: AtlaskitDraggableOptions["onDrop"];
};

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
  draggable({
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
