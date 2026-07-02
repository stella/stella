/**
 * Active DOCX editor registry.
 *
 * The editor ref + unlock callback live inside DocxBrowserEditor.
 * The inspector tab needs the same handles to apply suggestions
 * from its Suggestions facet, but the inspector is mounted outside
 * the editor's React subtree. This store bridges them: the editor
 * publishes its handles when it mounts and clears them on unmount;
 * consumers (the Suggestions and Playbook facets) read by
 * (entity id, file field id).
 *
 * Keying by (entity, file field) rather than entity alone matters:
 * one entity can hold multiple DOCX file fields, each open in its
 * own kept-mounted inspector tab with its own editor. A per-entity
 * slot would let the last-mounted editor overwrite the others,
 * routing one field's facet into another field's editor.
 */

import type { RefObject } from "react";

import { create } from "zustand";

import type { DocxEditorRef } from "@stll/folio";

// Registrations are keyed per (entity, file field): an entity can hold multiple
// file fields, each a distinct document with its own live editor. Mirrors
// `reviewSessionKey` in playbook-review-store.ts.
export const activeDocxKey = (entityId: string, fileFieldId: string): string =>
  `${entityId}:${fileFieldId}`;

export type ActiveDocxRegistration = {
  editorRef: RefObject<DocxEditorRef | null>;
  requestEditMode: () => boolean | Promise<boolean>;
  editable: boolean;
};

/**
 * Opaque token returned by `registerEditor` and passed back to
 * `unregisterEditor` so the registry can ignore stale unmount
 * cleanups. Without this, two editor instances briefly coexisting
 * for the same (entity, file field) (StrictMode double-invoke,
 * fast-remount during route transitions) race: instance B mounts
 * and overwrites A's slot, then A's cleanup runs and
 * unconditionally deletes B's registration, leaving the live editor
 * unreachable from the Suggestions facet.
 */
export type ActiveDocxRegistrationToken = symbol;

type State = {
  byKey: Record<
    string,
    { token: ActiveDocxRegistrationToken; registration: ActiveDocxRegistration }
  >;
};

type Actions = {
  registerEditor: (
    entityId: string,
    fileFieldId: string,
    registration: ActiveDocxRegistration,
  ) => ActiveDocxRegistrationToken;
  updateEditable: (
    entityId: string,
    fileFieldId: string,
    editable: boolean,
    token?: ActiveDocxRegistrationToken,
  ) => void;
  unregisterEditor: (
    entityId: string,
    fileFieldId: string,
    token: ActiveDocxRegistrationToken,
  ) => void;
};

export const useActiveDocxStore = create<State & Actions>()((set) => ({
  byKey: {},

  registerEditor: (entityId, fileFieldId, registration) => {
    const key = activeDocxKey(entityId, fileFieldId);
    const token: ActiveDocxRegistrationToken = Symbol("active-docx");
    set((state) => ({
      byKey: {
        ...state.byKey,
        [key]: { token, registration },
      },
    }));
    return token;
  },

  updateEditable: (entityId, fileFieldId, editable, token) => {
    const key = activeDocxKey(entityId, fileFieldId);
    set((state) => {
      const current = state.byKey[key];
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
        byKey: {
          ...state.byKey,
          [key]: {
            token: current.token,
            registration: { ...current.registration, editable },
          },
        },
      };
    });
  },

  unregisterEditor: (entityId, fileFieldId, token) => {
    const key = activeDocxKey(entityId, fileFieldId);
    set((state) => {
      const current = state.byKey[key];
      // Only delete the slot if it still belongs to the caller —
      // a newer instance may have already taken over.
      if (!current || current.token !== token) {
        return state;
      }
      const { [key]: _, ...rest } = state.byKey;
      return { byKey: rest };
    });
  },
}));
