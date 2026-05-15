import { useEffect } from "react";
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
  return navigator.platform.toUpperCase().includes("MAC");
}

/**
 * Document-level keyboard shortcuts:
 *  - Cmd/Ctrl+F → open find dialog with selected text
 *  - Cmd/Ctrl+H → open replace dialog
 *  - Cmd/Ctrl+P → trigger the custom print path (intercepts the OS dialog)
 *  - Delete/Backspace → delete the currently selected table when nothing else
 *    is selected (works with both ProseMirror `CellSelection` whole-table
 *    selections and the layout-overlay table selection).
 */
export function useKeyboardShortcuts({
  pagedEditorRef,
  findReplace,
  tableSelection,
  onDirectPrint,
}: UseKeyboardShortcutsArgs): void {
  useEffect(() => {
    const openFindFromSelection = () => {
      const selection = window.getSelection();
      const selectedText =
        selection && !selection.isCollapsed ? selection.toString() : "";
      findReplace.openFind(selectedText);
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
      if (tableSelection.state.tableIndex !== null) {
        e.preventDefault();
        tableSelection.handleAction("deleteTable");
        return true;
      }
      return false;
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      const cmdOrCtrl = isMacPlatform() ? e.metaKey : e.ctrlKey;

      if (
        !cmdOrCtrl &&
        !e.shiftKey &&
        !e.altKey &&
        (e.key === "Delete" || e.key === "Backspace") &&
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
          onDirectPrint();
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [findReplace, tableSelection, pagedEditorRef, onDirectPrint]);
}
