import { create } from "zustand";

// Bridges a list/detail route's open-item view state to the app breadcrumb.
// The breadcrumb is route-based and can't see component state, so a detail
// view publishes the open item's name + an "exit to list" callback here; the
// breadcrumb reads it to render "<List> › <name>" and to navigate back.
// Used by view-state machines that aren't real $id routes (templates, clauses).

export type OpenDetail = { id: string; name: string; exit: () => void };

export type DetailNavState = {
  open: OpenDetail | null;
  setOpen: (open: OpenDetail) => void;
  /** Update the open item's displayed name after an inline rename, keyed by id
   *  so a rename that resolves after the user already opened another item
   *  can't clobber the now-open item's breadcrumb. */
  setName: (id: string, name: string) => void;
  clear: () => void;
};

export const createDetailNavStore = () =>
  create<DetailNavState>((set) => ({
    open: null,
    setOpen: (open) => set({ open }),
    setName: (id, name) =>
      set((state) =>
        state.open && state.open.id === id
          ? { open: { ...state.open, name } }
          : state,
      ),
    clear: () => set({ open: null }),
  }));
