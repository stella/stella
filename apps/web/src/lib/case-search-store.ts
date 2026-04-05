/**
 * Find-in-page state for the case law viewer. The toolbar lives
 * in the app header (next to the decision metadata sheet) while
 * highlighting happens inside the decision reader. Both sides
 * subscribe to this store so there is a single source of truth
 * for open state, the query, and match navigation.
 */

import { create } from "zustand";

type CaseSearchStore = {
  isOpen: boolean;
  /** Incremented on every `open()` call so the toolbar can focus
   *  its input even when the toolbar was already open. */
  focusSeq: number;
  query: string;
  matchCount: number;
  activeMatchIndex: number;
  open: () => void;
  close: () => void;
  setQuery: (query: string) => void;
  setMatchCount: (matchCount: number) => void;
  goToNext: () => void;
  goToPrevious: () => void;
  reset: () => void;
};

export const useCaseSearchStore = create<CaseSearchStore>((set, get) => ({
  isOpen: false,
  focusSeq: 0,
  query: "",
  matchCount: 0,
  activeMatchIndex: 0,
  open: () => set({ isOpen: true, focusSeq: get().focusSeq + 1 }),
  close: () => set({ isOpen: false, query: "", activeMatchIndex: 0 }),
  setQuery: (query) => set({ query, activeMatchIndex: 0 }),
  setMatchCount: (matchCount) => {
    const { activeMatchIndex } = get();
    set({
      matchCount,
      activeMatchIndex:
        matchCount === 0 ? 0 : Math.min(activeMatchIndex, matchCount - 1),
    });
  },
  goToNext: () => {
    const { matchCount, activeMatchIndex } = get();
    if (matchCount === 0) {
      return;
    }
    set({ activeMatchIndex: (activeMatchIndex + 1) % matchCount });
  },
  goToPrevious: () => {
    const { matchCount, activeMatchIndex } = get();
    if (matchCount === 0) {
      return;
    }
    set({ activeMatchIndex: (activeMatchIndex - 1 + matchCount) % matchCount });
  },
  reset: () =>
    set({
      isOpen: false,
      query: "",
      matchCount: 0,
      activeMatchIndex: 0,
    }),
}));
