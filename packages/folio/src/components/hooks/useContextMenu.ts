import { useCallback, useState } from "react";
import type { RefObject } from "react";

import type { EditorView } from "prosemirror-view";

import { isInTable } from "../../core/prosemirror";
import type { PagedEditorRef } from "../../paged-editor/PagedEditor";

export type ContextMenuAnchor = { x: number; y: number };

export type ContextMenuState = {
  isOpen: boolean;
  position: ContextMenuAnchor;
  hasSelection: boolean;
  selectionRange: { from: number; to: number };
  cursorInTable: boolean;
  cursorInTrackedChange: boolean;
};

const CLOSED_STATE: ContextMenuState = {
  isOpen: false,
  position: { x: 0, y: 0 },
  hasSelection: false,
  selectionRange: { from: 0, to: 0 },
  cursorInTable: false,
  cursorInTrackedChange: false,
};

/**
 * True when the cursor sits on a text node carrying an `insertion` or
 * `deletion` mark — i.e., inside a tracked-change region. Used to decide
 * whether to surface accept/reject items in the context menu.
 */
function isCursorOnTrackedChange(view: EditorView): boolean {
  const { from } = view.state.selection;
  const $pos = view.state.doc.resolve(from);
  const node = $pos.parent;
  if (!node.isTextblock) {
    return false;
  }
  let onTrackedChange = false;
  // oxlint-disable-next-line unicorn/no-array-for-each -- ProseMirror Node.forEach
  node.forEach((child, offset) => {
    const start = $pos.start() + offset;
    const end = start + child.nodeSize;
    if (
      from >= start &&
      from <= end &&
      child.isText &&
      child.marks.some(
        (m) => m.type.name === "insertion" || m.type.name === "deletion",
      )
    ) {
      onTrackedChange = true;
    }
  });
  return onTrackedChange;
}

export type UseContextMenuArgs = {
  pagedEditorRef: RefObject<PagedEditorRef | null>;
};

export type UseContextMenuReturn = {
  contextMenu: ContextMenuState;
  /**
   * Open the menu at `anchor`. Reads the live PM selection from
   * `pagedEditorRef` to decide whether to enable selection-only,
   * table-only, and tracked-change-only menu items.
   *
   * `hasSelectionOverride` is for the PagedEditor child callback path,
   * which already knows from a layout-overlay selection whether the user
   * has highlighted text; when omitted we derive it from the PM selection.
   */
  openMenu: (anchor: ContextMenuAnchor, hasSelectionOverride?: boolean) => void;
  closeMenu: () => void;
};

export function useContextMenu({
  pagedEditorRef,
}: UseContextMenuArgs): UseContextMenuReturn {
  const [contextMenu, setContextMenu] =
    useState<ContextMenuState>(CLOSED_STATE);

  const openMenu = useCallback(
    (anchor: ContextMenuAnchor, hasSelectionOverride?: boolean) => {
      const view = pagedEditorRef.current?.getView();
      const selection = view?.state.selection ?? { from: 0, to: 0 };
      const hasSelection =
        hasSelectionOverride ?? selection.from !== selection.to;
      const cursorInTable = view ? isInTable(view.state) : false;
      const cursorInTrackedChange = view
        ? isCursorOnTrackedChange(view)
        : false;

      setContextMenu({
        isOpen: true,
        position: anchor,
        hasSelection,
        selectionRange: { from: selection.from, to: selection.to },
        cursorInTable,
        cursorInTrackedChange,
      });
    },
    [pagedEditorRef],
  );

  const closeMenu = useCallback(() => {
    setContextMenu(CLOSED_STATE);
  }, []);

  return { contextMenu, openMenu, closeMenu };
}
