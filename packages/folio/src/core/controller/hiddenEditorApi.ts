/**
 * Hidden-editor imperative API
 *
 * Framework-agnostic method surface for the off-screen ProseMirror editor.
 * Operates on an injected view accessor plus the document context and
 * destruction guard, so the same imperative handle can be driven from the
 * React component or a headless controller without depending on React.
 */

import { undo, redo } from "prosemirror-history";
import type { Command, EditorState, Transaction } from "prosemirror-state";
import { NodeSelection, Selection, TextSelection } from "prosemirror-state";
import { CellSelection } from "prosemirror-tables";
import type { EditorView } from "prosemirror-view";

import { fromProseDoc } from "../prosemirror/conversion/fromProseDoc";
import type { Document } from "../types/document";

export type HiddenEditorApi = {
  /** Request the off-screen EditorView (idempotent; creates it when possible). */
  ensureView: () => void;
  /** Whether view creation has been requested. */
  isViewRequested: () => boolean;
  /** Get the ProseMirror EditorState */
  getState: () => EditorState | null;
  /** Get the ProseMirror EditorView */
  getView: () => EditorView | null;
  /** Get the current Document from PM state */
  getDocument: () => Document | null;
  /** Focus the hidden editor */
  focus: () => void;
  /** Blur the hidden editor */
  blur: () => void;
  /** Check if focused */
  isFocused: () => boolean;
  /** Dispatch a transaction */
  dispatch: (tr: Transaction) => void;
  /** Execute a ProseMirror command */
  executeCommand: (command: Command) => boolean;
  /** Undo */
  undo: () => boolean;
  /** Redo */
  redo: () => boolean;
  /** Check if undo is available */
  canUndo: () => boolean;
  /** Check if redo is available */
  canRedo: () => boolean;
  /** Set selection by PM position */
  setSelection: (anchor: number, head?: number) => void;
  /** Set node selection at a PM position (for images, etc.) */
  setNodeSelection: (pos: number) => void;
  /** Set cell selection between two positions inside table cells */
  setCellSelection: (anchorCellPos: number, headCellPos: number) => void;
  /** Scroll the PM view to selection (no-op since hidden) */
  scrollToSelection: () => void;
};

export type HiddenEditorApiDeps = {
  getView: () => EditorView | null;
  getDocumentContext: () => Document | null;
  isDestroying: () => boolean;
  ensureView: () => void;
  isViewRequested: () => boolean;
};

/**
 * Convert PM state to Document
 */
const stateToDocument = (
  state: EditorState,
  originalDoc: Document | null,
): Document | null => {
  if (!originalDoc) {
    return null;
  }

  // fromProseDoc preserves the base document structure when provided
  return fromProseDoc(state.doc, originalDoc);
};

export const createHiddenEditorApi = (
  deps: HiddenEditorApiDeps,
): HiddenEditorApi => {
  // Skip dispatching while the view is being destroyed. Every dispatching
  // method routes through this so the framework-agnostic API is self-sufficient
  // rather than relying on the host view's dispatchTransaction backstop.
  const dispatchTr = (view: EditorView, tr: Transaction): void => {
    if (!deps.isDestroying()) {
      view.dispatch(tr);
    }
  };

  const setSelection = (anchor: number, head?: number): void => {
    const view = deps.getView();
    if (!view) {
      return;
    }
    const { state } = view;
    const docEnd = state.doc.content.size;
    const clampedAnchor = Math.max(0, Math.min(anchor, docEnd));
    const clampedHead =
      head === undefined ? clampedAnchor : Math.max(0, Math.min(head, docEnd));
    const $anchor = state.doc.resolve(clampedAnchor);
    const $head = state.doc.resolve(clampedHead);
    const selection =
      head === undefined
        ? Selection.near($anchor)
        : TextSelection.between($anchor, $head);
    dispatchTr(view, state.tr.setSelection(selection));
  };

  return {
    ensureView: deps.ensureView,

    isViewRequested: deps.isViewRequested,

    getState: () => deps.getView()?.state ?? null,

    getView: () => deps.getView() ?? null,

    getDocument: () => {
      const view = deps.getView();
      if (!view) {
        return null;
      }
      return stateToDocument(view.state, deps.getDocumentContext());
    },

    focus: () => {
      deps.getView()?.focus();
    },

    blur: () => {
      const view = deps.getView();
      const dom = view?.dom;
      if (view?.hasFocus() && dom instanceof HTMLElement) {
        dom.blur();
      }
    },

    isFocused: () => deps.getView()?.hasFocus() ?? false,

    dispatch: (tr: Transaction) => {
      const view = deps.getView();
      if (view) {
        dispatchTr(view, tr);
      }
    },

    executeCommand: (command: Command) => {
      const view = deps.getView();
      if (!view) {
        return false;
      }
      return command(view.state, (tr) => dispatchTr(view, tr), view);
    },

    undo: () => {
      const view = deps.getView();
      if (!view) {
        return false;
      }
      return undo(view.state, (tr) => dispatchTr(view, tr));
    },

    redo: () => {
      const view = deps.getView();
      if (!view) {
        return false;
      }
      return redo(view.state, (tr) => dispatchTr(view, tr));
    },

    canUndo: () => {
      const view = deps.getView();
      if (!view) {
        return false;
      }
      return undo(view.state);
    },

    canRedo: () => {
      const view = deps.getView();
      if (!view) {
        return false;
      }
      return redo(view.state);
    },

    setSelection,

    setNodeSelection: (pos: number) => {
      const view = deps.getView();
      if (!view) {
        return;
      }
      const { state } = view;
      try {
        const selection = NodeSelection.create(state.doc, pos);
        dispatchTr(view, state.tr.setSelection(selection));
      } catch {
        // Fallback to text selection if NodeSelection fails
        setSelection(pos);
      }
    },

    setCellSelection: (anchorCellPos: number, headCellPos: number) => {
      const view = deps.getView();
      if (!view) {
        return;
      }
      const { state } = view;
      try {
        const cellSel = CellSelection.create(
          state.doc,
          anchorCellPos,
          headCellPos,
        );
        dispatchTr(view, state.tr.setSelection(cellSel));
      } catch {
        // Fallback to text selection if positions aren't valid for CellSelection
        setSelection(anchorCellPos, headCellPos);
      }
    },

    scrollToSelection: () => {
      // No-op for hidden editor - visual scrolling handled by PagedEditor
    },
  };
};
