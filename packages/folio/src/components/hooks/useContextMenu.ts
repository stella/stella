import { useCallback, useMemo, useState } from "react";
import type { RefObject } from "react";

import type { EditorView } from "prosemirror-view";

import {
  TextSelection,
  isInTable,
  addRowAbove,
  addRowBelow,
  deleteRow as pmDeleteRow,
  addColumnLeft,
  addColumnRight,
  deleteColumn as pmDeleteColumn,
} from "../../core/prosemirror";
import {
  acceptChange,
  rejectChange,
  findChangeAtPosition,
} from "../../core/prosemirror/commands/comments";
import type {
  TextContextAction,
  TextContextMenuItem,
} from "../TextContextMenu";

// ============================================================================
// TYPES
// ============================================================================

type ContextMenuState = {
  isOpen: boolean;
  position: { x: number; y: number };
  hasSelection: boolean;
  selectionRange: { from: number; to: number };
  cursorInTable: boolean;
  cursorInTrackedChange: boolean;
};

const INITIAL_CONTEXT_MENU_STATE: ContextMenuState = {
  isOpen: false,
  position: { x: 0, y: 0 },
  hasSelection: false,
  selectionRange: { from: 0, to: 0 },
  cursorInTable: false,
  cursorInTrackedChange: false,
};

/**
 * Find the Y position (relative to parentEl) of the element containing the given PM position.
 */
function findSelectionYPosition(
  scrollContainer: HTMLElement | null,
  parentEl: HTMLElement | null,
  pmPos: number,
): number | null {
  if (!scrollContainer || !parentEl) {
    return null;
  }
  const pagesEl = scrollContainer.querySelector(".paged-editor__pages");
  if (!pagesEl) {
    return null;
  }
  const elements = pagesEl.querySelectorAll("[data-pm-start]");
  for (const node of elements) {
    const el = node as HTMLElement;
    const pmStart = Number(el.dataset["pmStart"]);
    const pmEnd = Number(el.dataset["pmEnd"]);
    if (pmPos >= pmStart && pmPos <= pmEnd) {
      return (
        el.getBoundingClientRect().top - parentEl.getBoundingClientRect().top
      );
    }
  }
  return null;
}

/**
 * Detect whether the cursor is on a tracked change mark.
 */
function detectTrackedChange(view: EditorView, from: number): boolean {
  const $pos = view.state.doc.resolve(from);
  const node = $pos.parent;
  if (!node.isTextblock) {
    return false;
  }
  let inTrackedChange = false;
  // oxlint-disable-next-line unicorn/no-array-for-each -- ProseMirror Node.forEach
  node.forEach((child, offset) => {
    const childStart = $pos.start() + offset;
    const childEnd = childStart + child.nodeSize;
    if (
      from >= childStart &&
      from <= childEnd &&
      child.isText &&
      child.marks.some(
        (m) => m.type.name === "insertion" || m.type.name === "deletion",
      )
    ) {
      inTrackedChange = true;
    }
  });
  return inTrackedChange;
}

// ============================================================================
// HOOK OPTIONS
// ============================================================================

type UseContextMenuOptions = {
  /** Returns the currently active ProseMirror editor view */
  getActiveEditorView: () => EditorView | null | undefined;
  /** Focuses the currently active editor */
  focusActiveEditor: () => void;
  /** Returns the raw ProseMirror view (main body editor, ignoring HF mode) */
  getBodyEditorView: () => EditorView | null | undefined;
  /** Ref to the scroll container wrapping the editor pages */
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  /** Ref to the editor content div (used for Y position calculation) */
  editorContentRef: RefObject<HTMLDivElement | null>;
  /** Pending comment ID constant */
  pendingCommentId: number;
  /** Callback to initiate add-comment flow from context menu */
  onAddComment: (params: {
    from: number;
    to: number;
    yPosition: number | null;
  }) => void;
};

// ============================================================================
// HOOK
// ============================================================================

export const useContextMenu = ({
  getActiveEditorView,
  focusActiveEditor,
  getBodyEditorView,
  scrollContainerRef,
  editorContentRef,
  pendingCommentId,
  onAddComment,
}: UseContextMenuOptions) => {
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(
    INITIAL_CONTEXT_MENU_STATE,
  );

  /**
   * Handler attached to the outer editor content wrapper (onContextMenu on the div).
   * Prevents the default browser context menu and opens the custom one.
   */
  const handleEditorContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const view = getBodyEditorView();
      const inTable = view ? isInTable(view.state) : false;
      const { from, to } = view?.state.selection ?? { from: 0, to: 0 };
      const hasSel = from !== to;
      const inTrackedChange = view ? detectTrackedChange(view, from) : false;
      setContextMenu({
        isOpen: true,
        position: { x: e.clientX, y: e.clientY },
        hasSelection: hasSel,
        selectionRange: { from, to },
        cursorInTable: inTable,
        cursorInTrackedChange: inTrackedChange,
      });
    },
    [getBodyEditorView],
  );

  /**
   * Handler forwarded from PagedEditor's onContextMenu prop.
   * Receives pre-computed position and selection data.
   */
  const handleContextMenu = useCallback(
    (data: { x: number; y: number; hasSelection: boolean }) => {
      const view = getBodyEditorView();
      const inTable = view ? isInTable(view.state) : false;
      const inChange = view
        ? detectTrackedChange(view, view.state.selection.from)
        : false;
      const sel = view?.state.selection ?? { from: 0, to: 0 };
      setContextMenu({
        isOpen: true,
        position: data,
        hasSelection: data.hasSelection,
        selectionRange: { from: sel.from, to: sel.to },
        cursorInTable: inTable,
        cursorInTrackedChange: inChange,
      });
    },
    [getBodyEditorView],
  );

  const handleContextMenuClose = useCallback(() => {
    setContextMenu(INITIAL_CONTEXT_MENU_STATE);
  }, []);

  const contextMenuItems = useMemo((): TextContextMenuItem[] => {
    const isMac =
      typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
    const mod = isMac ? "⌘" : "Ctrl";
    const items: TextContextMenuItem[] = [
      { action: "cut", label: "Cut", shortcut: `${mod}+X` },
      { action: "copy", label: "Copy", shortcut: `${mod}+C` },
      { action: "paste", label: "Paste", shortcut: `${mod}+V` },
      {
        action: "pasteAsPlainText",
        label: "Paste as Plain Text",
        shortcut: `${mod}+Shift+V`,
        dividerAfter: true,
      },
      {
        action: "delete",
        label: "Delete",
        shortcut: "Del",
        dividerAfter: !contextMenu.hasSelection && !contextMenu.cursorInTable,
      },
    ];
    if (contextMenu.hasSelection) {
      items.push({
        action: "addComment",
        label: "Comment",
        dividerAfter: !contextMenu.cursorInTable,
      });
    }
    if (contextMenu.cursorInTable) {
      items.push(
        { action: "addRowAbove", label: "Insert row above" },
        { action: "addRowBelow", label: "Insert row below" },
        { action: "deleteRow", label: "Delete row", dividerAfter: true },
        { action: "addColumnLeft", label: "Insert column left" },
        { action: "addColumnRight", label: "Insert column right" },
        {
          action: "deleteColumn",
          label: "Delete column",
          dividerAfter: true,
        },
      );
    }
    if (contextMenu.cursorInTrackedChange) {
      items.push(
        { action: "acceptChange", label: "Accept Change" },
        {
          action: "rejectChange",
          label: "Reject Change",
          dividerAfter: true,
        },
      );
    }
    items.push({
      action: "selectAll",
      label: "Select All",
      shortcut: `${mod}+A`,
    });
    return items;
  }, [
    contextMenu.hasSelection,
    contextMenu.cursorInTable,
    contextMenu.cursorInTrackedChange,
  ]);

  const handleContextMenuAction = useCallback(
    async (action: TextContextAction) => {
      const view = getActiveEditorView();
      if (!view) {
        return;
      }

      // Focus the hidden PM so clipboard operations target the right element
      focusActiveEditor();

      switch (action) {
        case "cut": {
          // Copy selected text to clipboard, then delete selection
          const { from, to } = view.state.selection;
          const text = view.state.doc.textBetween(from, to, "\n");
          void navigator.clipboard.writeText(text);
          view.dispatch(view.state.tr.deleteSelection());
          break;
        }
        case "copy": {
          const { from: cf, to: ct } = view.state.selection;
          const copied = view.state.doc.textBetween(cf, ct, "\n");
          void navigator.clipboard.writeText(copied);
          break;
        }
        case "paste": {
          // Use Clipboard API — document.execCommand('paste') is blocked in modern browsers
          try {
            const items = await navigator.clipboard.read();
            let html = "";
            let text = "";
            for (const item of items) {
              if (item.types.includes("text/html")) {
                html = await (await item.getType("text/html")).text();
              }
              if (item.types.includes("text/plain")) {
                text = await (await item.getType("text/plain")).text();
              }
            }
            const dt = new DataTransfer();
            if (html) {
              dt.items.add(html, "text/html");
            }
            if (text) {
              dt.items.add(text, "text/plain");
            }
            const pasteEvent = new ClipboardEvent("paste", {
              clipboardData: dt,
              bubbles: true,
              cancelable: true,
            });
            view.dom.dispatchEvent(pasteEvent);
          } catch {
            try {
              const text = await navigator.clipboard.readText();
              if (text) {
                view.dispatch(view.state.tr.insertText(text));
              }
            } catch {
              // Clipboard access denied
            }
          }
          break;
        }
        case "pasteAsPlainText":
          try {
            const text = await navigator.clipboard.readText();
            if (text) {
              view.dispatch(view.state.tr.insertText(text));
            }
          } catch {
            // Clipboard access denied
          }
          break;
        case "delete": {
          const { from, to } = view.state.selection;
          if (from !== to) {
            view.dispatch(view.state.tr.deleteRange(from, to));
          }
          break;
        }
        case "selectAll":
          view.dispatch(
            view.state.tr.setSelection(
              TextSelection.create(
                view.state.doc,
                0,
                view.state.doc.content.size,
              ),
            ),
          );
          break;
        // Table operations
        case "addRowAbove":
          addRowAbove(view.state, view.dispatch);
          break;
        case "addRowBelow":
          addRowBelow(view.state, view.dispatch);
          break;
        case "deleteRow":
          pmDeleteRow(view.state, view.dispatch);
          break;
        case "addColumnLeft":
          addColumnLeft(view.state, view.dispatch);
          break;
        case "addColumnRight":
          addColumnRight(view.state, view.dispatch);
          break;
        case "deleteColumn":
          pmDeleteColumn(view.state, view.dispatch);
          break;
        // Comment — same flow as floating comment button
        case "addComment": {
          // Use the stored selection range from when the context menu opened,
          // because right-click may collapse the PM selection to a cursor
          const { from, to } =
            contextMenu.selectionRange.from !== contextMenu.selectionRange.to
              ? contextMenu.selectionRange
              : view.state.selection;
          if (from === to) {
            break;
          }
          // Compute Y position BEFORE dispatching — dispatch triggers re-layout
          // which rebuilds page DOM and invalidates the old span elements
          const yPos = findSelectionYPosition(
            scrollContainerRef.current,
            editorContentRef.current,
            from,
          );
          const pendingMark = view.state.schema.marks["comment"]!.create({
            commentId: pendingCommentId,
          });
          const tr = view.state.tr.addMark(from, to, pendingMark);
          tr.setSelection(TextSelection.create(tr.doc, to));
          view.dispatch(tr);
          onAddComment({ from, to, yPosition: yPos });
          break;
        }
        case "acceptChange": {
          const { from, to } = view.state.selection;
          const range = findChangeAtPosition(view.state, from, to);
          acceptChange(range.from, range.to)(view.state, view.dispatch);
          break;
        }
        case "rejectChange": {
          const { from, to } = view.state.selection;
          const range = findChangeAtPosition(view.state, from, to);
          rejectChange(range.from, range.to)(view.state, view.dispatch);
          break;
        }
        default:
          break;
      }
      // TextContextMenu calls onClose after onAction, so no need to close here
    },
    [
      getActiveEditorView,
      focusActiveEditor,
      contextMenu.selectionRange,
      scrollContainerRef,
      editorContentRef,
      pendingCommentId,
      onAddComment,
    ],
  );

  return {
    contextMenu,
    setContextMenu,
    handleEditorContextMenu,
    handleContextMenu,
    handleContextMenuClose,
    handleContextMenuAction,
    contextMenuItems,
  };
};
