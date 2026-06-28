// The composition half of the headless editor controller (seam-architecture
// Seam 6: `FolioEditor`). Unifies the hidden-editor imperative API, layout
// access, and the event emitter into one framework-agnostic object that
// framework adapters and desktop/headless hosts drive. Kept in `core/` with no
// React or `paged-editor/*` dependency so it stays portable across hosts.

import type { EditorState } from "prosemirror-state";

import type { Layout } from "../layout-engine/types";
import type { FolioEditorEmitter } from "./folioEditorEvents";
import type { HiddenEditorApi } from "./hiddenEditorApi";
import type { LayoutRunOptions } from "./layoutScheduler";

export type FolioEditorDeps = {
  // The live hidden-editor API; null until the view exists (the adapter holds
  // it in a ref), so it's read fresh on every call.
  getEditorApi: () => HiddenEditorApi | null;
  getLayout: () => Layout | null;
  runLayout: (state: EditorState, options: LayoutRunOptions) => void;
  emitter: FolioEditorEmitter;
};

// The headless controller surface (Seam 6). The HiddenEditorApi methods plus
// layout access and event subscription.
export type FolioEditor = HiddenEditorApi & {
  getLayout: () => Layout | null;
  /** Re-run layout for the current editor state (no-op if there is no view). */
  relayout: () => void;
  on: FolioEditorEmitter["on"];
};

export const createFolioEditor = (deps: FolioEditorDeps): FolioEditor => ({
  ensureView: () => deps.getEditorApi()?.ensureView(),

  isViewRequested: () => deps.getEditorApi()?.isViewRequested() ?? false,

  getState: () => deps.getEditorApi()?.getState() ?? null,

  getView: () => deps.getEditorApi()?.getView() ?? null,

  getDocument: () => deps.getEditorApi()?.getDocument() ?? null,

  focus: () => deps.getEditorApi()?.focus(),

  blur: () => deps.getEditorApi()?.blur(),

  isFocused: () => deps.getEditorApi()?.isFocused() ?? false,

  dispatch: (tr) => deps.getEditorApi()?.dispatch(tr),

  executeCommand: (command) =>
    deps.getEditorApi()?.executeCommand(command) ?? false,

  undo: () => deps.getEditorApi()?.undo() ?? false,

  redo: () => deps.getEditorApi()?.redo() ?? false,

  canUndo: () => deps.getEditorApi()?.canUndo() ?? false,

  canRedo: () => deps.getEditorApi()?.canRedo() ?? false,

  setSelection: (anchor, head) =>
    deps.getEditorApi()?.setSelection(anchor, head),

  setNodeSelection: (pos) => deps.getEditorApi()?.setNodeSelection(pos),

  setCellSelection: (anchorCellPos, headCellPos) =>
    deps.getEditorApi()?.setCellSelection(anchorCellPos, headCellPos),

  scrollToSelection: () => deps.getEditorApi()?.scrollToSelection(),

  getLayout: () => deps.getLayout(),

  relayout: () => {
    const state = deps.getEditorApi()?.getState();
    if (state) {
      deps.runLayout(state, { reason: "manual" });
    }
  },

  on: deps.emitter.on,
});
