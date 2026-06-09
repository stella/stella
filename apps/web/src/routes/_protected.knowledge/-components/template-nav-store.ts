import { create } from "zustand";

// Bridges the templates route's open-template view state to the app breadcrumb.
// The breadcrumb is route-based and can't see component state, so the detail
// view publishes the open template id + an "exit to list" callback here; the
// breadcrumb reads it to render "Templates › <name>" and to navigate back.
// (The templates list/detail is a view-state machine, not a $templateId route.)

type OpenTemplate = { templateId: string; name: string; exit: () => void };

type TemplateNavState = {
  open: OpenTemplate | null;
  setOpen: (open: OpenTemplate) => void;
  /** Update the open template's displayed name (e.g. after an inline rename). */
  setName: (name: string) => void;
  clear: () => void;
};

export const useTemplateNavStore = create<TemplateNavState>((set) => ({
  open: null,
  setOpen: (open) => set({ open }),
  setName: (name) =>
    set((state) => (state.open ? { open: { ...state.open, name } } : state)),
  clear: () => set({ open: null }),
}));
