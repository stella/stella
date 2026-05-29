/**
 * Surface adapter — gives the pointer pipeline a uniform shape for the body
 * PM and any HF PM, so a single resolved `activeSurface()` can drive click
 * routing / drag-select / focus from one code path.
 *
 * The body PM ref (`HiddenProseMirrorRef`) and the persistent HF PMs (raw
 * `EditorView` from `HiddenHeaderFooterPMs.getView()`) carry different APIs;
 * this adapter projects both onto a small intersection: focus, set selection,
 * get state, dispatch.
 */

import { Selection, TextSelection } from "prosemirror-state";
import type { EditorState, Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

export type Surface = {
  /** Identity tag — `"body"` for the body PM, `"hf"` for any HF PM. */
  kind: "body" | "hf";
  /** rId of the source HF part; `null` for the body surface. */
  rId: string | null;
  getState(): EditorState | null;
  getView(): EditorView | null;
  focus(): void;
  isFocused(): boolean;
  dispatch(tr: Transaction): void;
  setSelection(anchor: number, head?: number): void;
};

export function wrapEditorViewAsSurface(
  view: EditorView | null,
  rId: string,
): Surface {
  return {
    kind: "hf",
    rId,
    getState: () => view?.state ?? null,
    getView: () => view,
    focus: () => view?.focus(),
    isFocused: () => view?.hasFocus() ?? false,
    dispatch: (tr) => view?.dispatch(tr),
    setSelection(anchor, head) {
      if (!view) {
        return;
      }
      const { state, dispatch } = view;
      const docEnd = state.doc.content.size;
      const clampedAnchor = Math.max(0, Math.min(anchor, docEnd));
      const clampedHead =
        head === undefined
          ? clampedAnchor
          : Math.max(0, Math.min(head, docEnd));
      const $anchor = state.doc.resolve(clampedAnchor);
      const $head = state.doc.resolve(clampedHead);
      const selection =
        head === undefined
          ? Selection.near($anchor)
          : TextSelection.between($anchor, $head);
      dispatch(state.tr.setSelection(selection));
    },
  };
}
