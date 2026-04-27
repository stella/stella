import { useCallback, useState } from "react";

import type { EditorView } from "prosemirror-view";

import {
  insertHyperlink,
  removeHyperlink,
  setHyperlink,
} from "../../core/prosemirror";
import { sanitizeExternalUrl } from "../../core/utils/urlSecurity";
import type {
  HyperlinkData,
  UseHyperlinkDialogReturn,
} from "../dialogs/HyperlinkDialog";
import type { HyperlinkPopupData } from "../ui/HyperlinkPopup";

// Toast stub — mirrors the one in DocxEditor.tsx.
const toast = (msg: string) => {
  const existing = document.querySelector("[data-folio-toast]");
  if (existing) {
    return;
  } // debounce rapid calls (e.g., key repeat)
  const el = document.createElement("div");
  el.dataset["folioToast"] = "";
  el.textContent = msg;
  Object.assign(el.style, {
    position: "fixed",
    bottom: "24px",
    left: "50%",
    transform: "translateX(-50%)",
    padding: "10px 20px",
    borderRadius: "8px",
    background: "var(--popover, #1f1f1f)",
    color: "var(--popover-foreground, #fff)",
    fontSize: "13px",
    boxShadow: "0 4px 12px var(--doc-shadow-lg, rgba(0,0,0,0.25))",
    zIndex: "9999",
  } satisfies Partial<CSSStyleDeclaration>);
  document.body.append(el);
  setTimeout(() => {
    el.remove();
  }, 2200);
};

// ============================================================================
// TYPES
// ============================================================================

export type UseHyperlinkHandlersDeps = {
  /** Returns the currently active ProseMirror editor view */
  getActiveEditorView: () => EditorView | null | undefined;
  /** Focuses the currently active editor */
  focusActiveEditor: () => void;
  /** The hyperlink dialog state manager (from useHyperlinkDialog) */
  hyperlinkDialog: UseHyperlinkDialogReturn;
};

export type UseHyperlinkHandlersReturn = {
  /** Popup state (Google Docs-style floating popup on link click) */
  hyperlinkPopupData: HyperlinkPopupData | null;
  /** Update popup state directly (used by keyboard shortcut handler) */
  setHyperlinkPopupData: (data: HyperlinkPopupData | null) => void;
  /** Handle hyperlink dialog form submission */
  handleHyperlinkSubmit: (data: HyperlinkData) => void;
  /** Handle hyperlink removal from the dialog */
  handleHyperlinkRemove: () => void;
  /** Handle hyperlink click to show popup */
  handleHyperlinkClick: (data: HyperlinkPopupData) => void;
  /** Navigate to the link URL in a new tab */
  handleHyperlinkPopupNavigate: (href: string) => void;
  /** Copy the link URL to clipboard */
  handleHyperlinkPopupCopy: (href: string) => void;
  /** Edit the hyperlink text and URL inline */
  handleHyperlinkPopupEdit: (displayText: string, href: string) => void;
  /** Remove the hyperlink mark from the popup */
  handleHyperlinkPopupRemove: () => void;
  /** Close the hyperlink popup */
  handleHyperlinkPopupClose: () => void;
};

// ============================================================================
// HOOK
// ============================================================================

export const useHyperlinkHandlers = ({
  getActiveEditorView,
  focusActiveEditor,
  hyperlinkDialog,
}: UseHyperlinkHandlersDeps): UseHyperlinkHandlersReturn => {
  const [hyperlinkPopupData, setHyperlinkPopupData] =
    useState<HyperlinkPopupData | null>(null);

  // Shared: remove hyperlink mark and refocus editor
  const doRemoveHyperlink = useCallback(() => {
    const view = getActiveEditorView();
    if (!view) {
      return;
    }
    removeHyperlink(view.state, view.dispatch);
    focusActiveEditor();
  }, [getActiveEditorView, focusActiveEditor]);

  // Handle hyperlink dialog submit
  const handleHyperlinkSubmit = useCallback(
    (data: HyperlinkData) => {
      const view = getActiveEditorView();
      if (!view) {
        return;
      }

      const url = data.url || "";
      const tooltip = data.tooltip;

      // Check if we have a selection
      const { empty } = view.state.selection;

      if (empty && data.displayText) {
        // No selection but display text provided - insert new linked text
        insertHyperlink(
          data.displayText,
          url,
          tooltip,
        )(view.state, view.dispatch);
      } else if (!empty) {
        // Have selection - apply hyperlink to it
        setHyperlink(url, tooltip)(view.state, view.dispatch);
      }

      hyperlinkDialog.close();
      focusActiveEditor();
    },
    [hyperlinkDialog, getActiveEditorView, focusActiveEditor],
  );

  // Handle hyperlink removal (from dialog)
  const handleHyperlinkRemove = useCallback(() => {
    doRemoveHyperlink();
    hyperlinkDialog.close();
  }, [hyperlinkDialog, doRemoveHyperlink]);

  // Handle hyperlink click — show popup
  const handleHyperlinkClick = useCallback(
    (data: HyperlinkPopupData) => setHyperlinkPopupData(data),
    [],
  );

  const handleHyperlinkPopupNavigate = useCallback((href: string) => {
    const safeHref = sanitizeExternalUrl(href);
    if (safeHref) {
      window.open(safeHref, "_blank", "noopener,noreferrer");
    }
  }, []);

  const handleHyperlinkPopupCopy = useCallback((href: string) => {
    void navigator.clipboard.writeText(href);
  }, []);

  const handleHyperlinkPopupEdit = useCallback(
    (displayText: string, href: string) => {
      const view = getActiveEditorView();
      if (!view) {
        return;
      }

      // Find the full hyperlink mark range at current cursor position
      const hlType = view.state.schema.marks["hyperlink"];
      if (!hlType) {
        return;
      }

      const { $from } = view.state.selection;
      const linkMark = $from.marks().find((m) => m.type === hlType);

      if (linkMark) {
        // Collect all contiguous text nodes with the same hyperlink mark
        const parent = $from.parent;
        const parentStart = $from.start();

        // Build ranges of consecutive hyperlink-marked nodes
        type Range = { start: number; end: number };
        const ranges: Range[] = [];
        let currentRange: Range | null = null;

        // oxlint-disable-next-line unicorn/no-array-for-each -- ProseMirror Node API
        parent.forEach((node, offset) => {
          const nodeStart = parentStart + offset;
          const nodeEnd = nodeStart + node.nodeSize;
          const hlMark = node.isText
            ? node.marks.find(
                (m) =>
                  m.type === hlType &&
                  m.attrs["href"] === linkMark.attrs["href"],
              )
            : null;

          if (hlMark) {
            if (currentRange) {
              currentRange.end = nodeEnd;
            } else {
              currentRange = { start: nodeStart, end: nodeEnd };
            }
          } else if (currentRange) {
            ranges.push(currentRange);
            currentRange = null;
          }
        });
        if (currentRange) {
          ranges.push(currentRange);
        }

        // Find the range that contains the cursor
        const cursorPos = $from.pos;
        const targetRange = ranges.find(
          (r) => r.start <= cursorPos && cursorPos <= r.end,
        );
        if (!targetRange) {
          return;
        }

        // Replace the text and mark
        const tr = view.state.tr;
        const newMark = hlType.create({
          href,
          tooltip: linkMark.attrs["tooltip"],
        });
        const textNode = view.state.schema.text(displayText, [
          ...$from.marks().filter((m) => m.type !== hlType),
          newMark,
        ]);
        tr.replaceWith(targetRange.start, targetRange.end, textNode);
        view.dispatch(tr.scrollIntoView());
      }

      setHyperlinkPopupData(null);
      focusActiveEditor();
    },
    [getActiveEditorView, focusActiveEditor],
  );

  const handleHyperlinkPopupRemove = useCallback(() => {
    const view = getActiveEditorView();
    if (!view) {
      return;
    }

    const hlType = view.state.schema.marks["hyperlink"];
    if (!hlType) {
      return;
    }

    const { $from } = view.state.selection;

    // Try $from.marks() first, then check the node after the cursor
    // (ProseMirror may not report marks at boundary positions)
    let linkMark = $from.marks().find((m) => m.type === hlType);
    if (!linkMark && $from.nodeAfter) {
      linkMark = $from.nodeAfter.marks.find((m) => m.type === hlType);
    }
    if (!linkMark && $from.nodeBefore) {
      linkMark = $from.nodeBefore.marks.find((m) => m.type === hlType);
    }

    // Fall back to searching by href from popup data
    if (!linkMark && hyperlinkPopupData) {
      const parent = $from.parent;
      // oxlint-disable-next-line unicorn/no-array-for-each -- ProseMirror Node API
      parent.forEach((node) => {
        if (!linkMark && node.isText) {
          const m = node.marks.find(
            (mk) =>
              mk.type === hlType &&
              mk.attrs["href"] === hyperlinkPopupData.href,
          );
          if (m) {
            linkMark = m;
          }
        }
      });
    }

    if (!linkMark) {
      return;
    }

    // Find contiguous range of nodes with matching hyperlink mark
    const parent = $from.parent;
    const parentStart = $from.start();
    type Range = { start: number; end: number };
    const ranges: Range[] = [];
    let currentRange: Range | null = null;

    // oxlint-disable-next-line unicorn/no-array-for-each -- ProseMirror Node API
    parent.forEach((node, offset) => {
      const nodeStart = parentStart + offset;
      const nodeEnd = nodeStart + node.nodeSize;
      const hlMark = node.isText
        ? node.marks.find(
            // oxlint-disable-next-line typescript/no-non-null-assertion
            (m) =>
              m.type === hlType && m.attrs["href"] === linkMark!.attrs["href"],
          )
        : null;

      if (hlMark) {
        if (currentRange) {
          currentRange.end = nodeEnd;
        } else {
          currentRange = { start: nodeStart, end: nodeEnd };
        }
      } else if (currentRange) {
        ranges.push(currentRange);
        currentRange = null;
      }
    });
    if (currentRange) {
      ranges.push(currentRange);
    }

    const cursorPos = $from.pos;
    const targetRange = ranges.find(
      (r) => r.start <= cursorPos && cursorPos <= r.end,
    );
    if (!targetRange) {
      return;
    }

    const tr = view.state.tr;
    tr.removeMark(targetRange.start, targetRange.end, hlType);
    view.dispatch(tr.scrollIntoView());

    setHyperlinkPopupData(null);
    focusActiveEditor();
    toast("Link removed");
  }, [getActiveEditorView, focusActiveEditor, hyperlinkPopupData]);

  const handleHyperlinkPopupClose = useCallback(() => {
    setHyperlinkPopupData(null);
  }, []);

  return {
    hyperlinkPopupData,
    setHyperlinkPopupData,
    handleHyperlinkSubmit,
    handleHyperlinkRemove,
    handleHyperlinkClick,
    handleHyperlinkPopupNavigate,
    handleHyperlinkPopupCopy,
    handleHyperlinkPopupEdit,
    handleHyperlinkPopupRemove,
    handleHyperlinkPopupClose,
  };
};
