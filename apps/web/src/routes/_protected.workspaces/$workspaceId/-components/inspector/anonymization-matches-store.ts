/**
 * Live snapshot of which anonymization terms are currently
 * highlighted in the open document.
 *
 * The Folio editor produces the match list (workspace catalog +
 * worker-detected entities) and publishes it here on every
 * dispatch / poll tick; the inspector facet reads the same store
 * to show "N terms highlighted" and to filter the workspace
 * vocabulary list to only the entries that actually appear in
 * the open file.
 *
 * Keyed by the document's `fieldId` so when the user switches
 * between docs the inspector sees zero matches for an
 * unmonitored field rather than stale numbers from another doc.
 */

import { create } from "zustand";

export type AnonymizationMatchSnapshot = {
  /** Total occurrence count across the whole doc. */
  totalMatches: number;
  /**
   * Per-canonical hit count. Keys mirror the term's `canonical`
   * string and values are the number of occurrences in the open
   * document. Use `.has(canonical)` for membership (matching
   * workspace terms only) and `.get(canonical)` for badges.
   */
  countByCanonical: ReadonlyMap<string, number>;
  /**
   * Per-canonical label (e.g. "person", "organization"). Used by
   * the inspector facet to group the detected list by category
   * and show a category badge per row. First occurrence wins
   * when a canonical somehow appears under multiple labels.
   */
  labelByCanonical: ReadonlyMap<string, string>;
};

type State = {
  byFieldId: Record<string, AnonymizationMatchSnapshot>;
};

type Actions = {
  publish: (fieldId: string, snapshot: AnonymizationMatchSnapshot) => void;
  clear: (fieldId: string) => void;
};

export const useAnonymizationMatchesStore = create<State & Actions>((set) => ({
  byFieldId: {},
  publish: (fieldId, snapshot) =>
    set((state) => ({
      byFieldId: { ...state.byFieldId, [fieldId]: snapshot },
    })),
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

const EMPTY_SNAPSHOT: AnonymizationMatchSnapshot = {
  totalMatches: 0,
  countByCanonical: new Map(),
  labelByCanonical: new Map(),
};

export const useAnonymizationMatches = (
  fieldId: string | null,
): AnonymizationMatchSnapshot =>
  useAnonymizationMatchesStore(
    (s) => (fieldId ? s.byFieldId[fieldId] : undefined) ?? EMPTY_SNAPSHOT,
  );
