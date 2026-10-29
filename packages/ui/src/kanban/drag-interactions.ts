import { autoScrollForElements } from "@atlaskit/pragmatic-drag-and-drop-auto-scroll/element";
import { autoScrollForExternal } from "@atlaskit/pragmatic-drag-and-drop-auto-scroll/external";
import { draggable } from "@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter";
import { combine } from "@atlaskit/pragmatic-drag-and-drop/utils/combine";
import { setCustomNativeDragPreview } from "@atlaskit/pragmatic-drag-and-drop/utils/set-custom-native-drag-preview";
import { panic } from "better-result";

type AtlaskitDraggableOptions = Parameters<typeof draggable>[0];

/**
 * Marks a card drag on the native `DataTransfer` so the board's native
 * `dragover`/`dragenter`/`dragleave` listeners (which also see reorders,
 * file drops, and any other native drag passing over the board) can tell a
 * kanban card drag from everything else. Pragmatic's `getInitialData` never
 * reaches those native events; only data attached this way does.
 */
export const KANBAN_CARD_DRAG_MIME =
  "application/x-stella-kanban-card" as const;

/**
 * What the pointer carries: the card itself, or a preview the caller draws
 * (a stack standing for several selected cards). `render` returns its own
 * cleanup, run once the browser has taken its snapshot.
 */
export type KanbanCardDragPreview =
  | { type: "card" }
  | { type: "custom"; render: (container: HTMLElement) => () => void };

export type RegisterKanbanCardDragOptions = {
  /** The drag wrapper rendered by `KanbanCardShell`. */
  element: AtlaskitDraggableOptions["element"];
  /** Domain data read by the board's drop monitor. */
  getInitialData: NonNullable<AtlaskitDraggableOptions["getInitialData"]>;
  /** Omit when every rendered card may move. */
  canDrag?: AtlaskitDraggableOptions["canDrag"];
  onDragStart?: AtlaskitDraggableOptions["onDragStart"];
  onDrop?: AtlaskitDraggableOptions["onDrop"];
  /** Read when the drag starts; omit to always carry the card. */
  getDragPreview?: (() => KanbanCardDragPreview) | undefined;
};

/** The styled card inside the shell's drag wrapper, at its rendered width. */
const appendCardClone = (element: Element, container: HTMLElement) => {
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
  getDragPreview,
}: RegisterKanbanCardDragOptions): (() => void) =>
  draggable({
    element,
    getInitialData,
    getInitialDataForExternal: () => ({ [KANBAN_CARD_DRAG_MIME]: "" }),
    ...(canDrag === undefined ? {} : { canDrag }),
    ...(onDragStart === undefined ? {} : { onDragStart }),
    ...(onDrop === undefined ? {} : { onDrop }),
    onGenerateDragPreview: ({ nativeSetDragImage }) => {
      setCustomNativeDragPreview({
        nativeSetDragImage,
        getOffset: ({ container }) => {
          const { width, height } = container.getBoundingClientRect();
          return { x: width / 2, y: height / 2 };
        },
        render: ({ container }) => {
          const preview: KanbanCardDragPreview = getDragPreview?.() ?? {
            type: "card",
          };
          switch (preview.type) {
            case "custom":
              return preview.render(container);
            case "card":
              appendCardClone(element, container);
              return undefined;
            default:
              preview satisfies never;
              return panic(`Unhandled kanban drag preview: ${String(preview)}`);
          }
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
