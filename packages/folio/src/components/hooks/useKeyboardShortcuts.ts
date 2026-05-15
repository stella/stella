import { useEffect, useRef } from "react";
import type { RefObject } from "react";

import {
  getTableContext,
  deleteTable as pmDeleteTable,
} from "../../core/prosemirror";
import type { PagedEditorRef } from "../../paged-editor/PagedEditor";
import type { UseFindReplaceReturn } from "../dialogs/useFindReplace";

export type UseKeyboardShortcutsArgs = {
  pagedEditorRef: RefObject<PagedEditorRef | null>;
  findReplace: UseFindReplaceReturn;
  tableSelection: {
    state: { tableIndex: number | null };
    handleAction: (action: "deleteTable") => void;
  };
  /** Triggered on Cmd/Ctrl+P. */
  onDirectPrint: () => void;
};

function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }
  return /Mac|iPod|iPhone|iPad/.test(navigator.platform);
}

/**
 * `target` is an input-like element that the user is typing into. We must
 * not intercept Delete/Backspace there — only when focus is in the editor
 * surface (or nowhere at all).
 */
function isFocusInInputLike(
  target: EventTarget | null,
  editorDom: HTMLElement | null | undefined,
): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") {
    return true;
  }
  if (target.isContentEditable && target !== editorDom) {
    return true;
  }
  return false;
}

/**
 * Document-level keyboard shortcuts:
 *  - Cmd/Ctrl+F → open find dialog with selected text
 *  - Cmd/Ctrl+H → open replace dialog
 *  - Cmd/Ctrl+P → trigger the custom print path (intercepts the OS dialog)
 *  - Delete/Backspace → delete the currently selected table when nothing else
 *    is selected (works with both ProseMirror `CellSelection` whole-table
 *    selections and the layout-overlay table selection). Suppressed when
 *    focus is in a non-editor input/textarea/contenteditable to avoid
 *    deleting tables while the user is typing in a sidebar or dialog.
 */
export function useKeyboardShortcuts({
  pagedEditorRef,
  findReplace,
  tableSelection,
  onDirectPrint,
}: UseKeyboardShortcutsArgs): void {
  // Keep callbacks fresh without re-attaching the global listener on every
  // change to `findReplace.state` (which updates on every search keystroke).
  const callbacksRef = useRef({ findReplace, tableSelection, onDirectPrint });
  callbacksRef.current = { findReplace, tableSelection, onDirectPrint };

  useEffect(() => {
    const openFindFromSelection = () => {
      const selection = window.getSelection();
      const selectedText =
        selection && !selection.isCollapsed ? selection.toString() : "";
      callbacksRef.current.findReplace.openFind(selectedText);
    };

    const tryDeleteSelectedTable = (e: KeyboardEvent): boolean => {
      const view = pagedEditorRef.current?.getView();
      if (view) {
        const sel = view.state.selection as {
          $anchorCell?: unknown;
          forEachCell?: unknown;
        };
        const isCellSel =
          "$anchorCell" in sel && typeof sel.forEachCell === "function";
        if (isCellSel) {
          const context = getTableContext(view.state);
          if (context.isInTable && context.table) {
            let totalCells = 0;
            context.table.descendants((node) => {
              if (
                node.type.name === "tableCell" ||
                node.type.name === "tableHeader"
              ) {
                totalCells += 1;
              }
            });
            let selectedCells = 0;
            (sel as { forEachCell: (fn: () => void) => void }).forEachCell(
              () => {
                selectedCells += 1;
              },
            );
            if (totalCells > 0 && selectedCells >= totalCells) {
              e.preventDefault();
              pmDeleteTable(view.state, view.dispatch);
              return true;
            }
          }
        }
      }
      if (callbacksRef.current.tableSelection.state.tableIndex !== null) {
        e.preventDefault();
        callbacksRef.current.tableSelection.handleAction("deleteTable");
        return true;
      }
      return false;
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      const cmdOrCtrl = isMacPlatform() ? e.metaKey : e.ctrlKey;
      const editorDom = pagedEditorRef.current?.getView()?.dom;

      if (
        !cmdOrCtrl &&
        !e.shiftKey &&
        !e.altKey &&
        (e.key === "Delete" || e.key === "Backspace") &&
        !isFocusInInputLike(e.target, editorDom) &&
        tryDeleteSelectedTable(e)
      ) {
        return;
      }

      if (cmdOrCtrl && !e.shiftKey && !e.altKey) {
        if (e.key.toLowerCase() === "f" || e.key.toLowerCase() === "h") {
          e.preventDefault();
          openFindFromSelection();
        } else if (e.key.toLowerCase() === "p" && !e.repeat) {
          e.preventDefault();
          callbacksRef.current.onDirectPrint();
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [pagedEditorRef]);
}
