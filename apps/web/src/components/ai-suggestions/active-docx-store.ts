/**
 * Active DOCX editor registry.
 *
 * The editor ref + unlock callback live inside DocxBrowserEditor.
 * The inspector tab needs the same handles to apply suggestions
 * from its Suggestions facet, but the inspector is mounted outside
 * the editor's React subtree. This store bridges them: the editor
 * publishes its handles when it mounts and clears them on unmount;
 * any consumer (the facet, the chat overlay's queueing path) reads
 * by entity id.
 */

import type { RefObject } from "react";

import type { DocxEditorRef } from "@stll/folio";
import { create } from "zustand";

export type ActiveDocxRegistration = {
  editorRef: RefObject<DocxEditorRef | null>;
  requestEditMode: () => boolean | Promise<boolean>;
  editable: boolean;
};

/**
 * Opaque token returned by `registerEditor` and passed back to
 * `unregisterEditor` so the registry can ignore stale unmount
 * cleanups. Without this, two editor instances briefly coexisting
 * for the same entity (StrictMode double-invoke, fast-remount
 * during route transitions) race: instance B mounts and overwrites
 * A's slot, then A's cleanup runs and unconditionally deletes B's
 * registration, leaving the live editor unreachable from the
 * Suggestions facet.
 */
export type ActiveDocxRegistrationToken = symbol;

type State = {
  byEntityId: Record<
    string,
    { token: ActiveDocxRegistrationToken; registration: ActiveDocxRegistration }
  >;
};

type Actions = {
  registerEditor: (
    entityId: string,
    registration: ActiveDocxRegistration,
  ) => ActiveDocxRegistrationToken;
  updateEditable: (
    entityId: string,
    editable: boolean,
    token?: ActiveDocxRegistrationToken,
  ) => void;
  unregisterEditor: (
    entityId: string,
    token: ActiveDocxRegistrationToken,
  ) => void;
};

export const useActiveDocxStore = create<State & Actions>()((set) => ({
  byEntityId: {},

  registerEditor: (entityId, registration) => {
    const token: ActiveDocxRegistrationToken = Symbol("active-docx");
    set((state) => ({
      byEntityId: {
        ...state.byEntityId,
        [entityId]: { token, registration },
      },
    }));
    return token;
  },

  updateEditable: (entityId, editable, token) => {
    set((state) => {
      const current = state.byEntityId[entityId];
      if (!current) {
        return state;
      }
      // Stale instance writing into a slot that's been replaced —
      // ignore.
      if (token !== undefined && token !== current.token) {
        return state;
      }
      if (current.registration.editable === editable) {
        return state;
      }
      return {
        byEntityId: {
          ...state.byEntityId,
          [entityId]: {
            token: current.token,
            registration: { ...current.registration, editable },
          },
        },
      };
    });
  },

  unregisterEditor: (entityId, token) => {
    set((state) => {
      const current = state.byEntityId[entityId];
      // Only delete the slot if it still belongs to the caller —
      // a newer instance may have already taken over.
      if (!current || current.token !== token) {
        return state;
      }
      const { [entityId]: _, ...rest } = state.byEntityId;
      return { byEntityId: rest };
    });
  },
}));
