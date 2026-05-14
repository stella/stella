/**
 * Two-way bridge between the document editor and the inspector
 * facet for the currently-selected anonymization canonical.
 *
 * - `doc` source: editor click on a highlighted term. Facet
 *   scrolls + flashes the matching row.
 * - `sidebar` source: row click in the facet. Editor scrolls
 *   the first occurrence into view and marks it as selected.
 *
 * `seq` bumps on every `select()` call even if canonical/label
 * are identical, so consumers re-fire the scroll-and-flash on
 * repeat clicks of the same term.
 */

import { create } from "zustand";

export type AnonymizationSelectionSource = "doc" | "sidebar";

type State = {
  canonical: string | null;
  label: string | null;
  source: AnonymizationSelectionSource | null;
  seq: number;
};

type Actions = {
  select: (
    canonical: string,
    label: string,
    source: AnonymizationSelectionSource,
  ) => void;
  clear: () => void;
};

const INITIAL_STATE: State = {
  canonical: null,
  label: null,
  source: null,
  seq: 0,
};

export const useAnonymizationSelectionStore = create<State & Actions>(
  (set) => ({
    ...INITIAL_STATE,
    select: (canonical, label, source) =>
      set((state) => ({
        canonical,
        label,
        source,
        seq: state.seq + 1,
      })),
    clear: () => set({ ...INITIAL_STATE }),
  }),
);
