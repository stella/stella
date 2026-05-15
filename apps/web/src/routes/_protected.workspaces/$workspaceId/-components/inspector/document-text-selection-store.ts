/**
 * Latest non-empty text selection inside a document
 * editor, keyed by `fieldId`. The folio paged editor
 * sets ProseMirror selections programmatically on its
 * off-screen hidden PM and renders the visible
 * selection via a custom overlay; that's invisible to
 * a global `selectionchange` listener, which is why the
 * inspector facet's "Term to anonymize" prefill needs a
 * dedicated bridge instead of `window.getSelection()`.
 *
 * The editor wrapper publishes here whenever the user
 * settles on a non-collapsed selection; the inspector
 * facet subscribes and seeds its term input.
 */

import { create } from "zustand";

export type DocumentTextSelection = {
  text: string;
  /**
   * Monotonic counter so re-selecting the exact same
   * text re-fires the prefill effect in subscribers.
   * Without it, repeated identical selections would
   * be deduped by reference equality and feel inert.
   */
  seq: number;
};

type State = {
  byFieldId: Record<string, DocumentTextSelection>;
};

type Actions = {
  publish: (fieldId: string, text: string) => void;
  clear: (fieldId: string) => void;
};

export const useDocumentTextSelectionStore = create<State & Actions>((set) => ({
  byFieldId: {},
  publish: (fieldId, text) =>
    set((state) => {
      const prev = state.byFieldId[fieldId];
      return {
        byFieldId: {
          ...state.byFieldId,
          [fieldId]: { text, seq: (prev?.seq ?? 0) + 1 },
        },
      };
    }),
  clear: (fieldId) =>
    set((state) => {
      if (!(fieldId in state.byFieldId)) {
        return state;
      }
      return {
        byFieldId: Object.fromEntries(
          Object.entries(state.byFieldId).filter(([id]) => id !== fieldId),
        ),
      };
    }),
}));

export const useDocumentTextSelection = (
  fieldId: string | null,
): DocumentTextSelection | null =>
  useDocumentTextSelectionStore((s) =>
    fieldId === null ? null : (s.byFieldId[fieldId] ?? null),
  );
