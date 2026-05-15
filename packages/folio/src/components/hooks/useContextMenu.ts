import { useCallback, useState } from "react";
import type { RefObject } from "react";

import { isInTable } from "../../core/prosemirror";
import type { PagedEditorRef } from "../../paged-editor/PagedEditor";
import { detectActiveTrackedChange } from "../selectionDetection";

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
        ? detectActiveTrackedChange(view.state) !== null
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
