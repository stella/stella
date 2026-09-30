import { create } from "zustand";

type QuickEntryScope = { userId: string; organizationId: string };
type QuickEntryState = {
  dialog: { status: "closed" } | ({ status: "open" } & QuickEntryScope);
  openDialog: (scope: QuickEntryScope) => void;
  closeDialog: () => void;
};

export const useQuickEntryStore = create<QuickEntryState>()((set) => ({
  dialog: { status: "closed" },
  openDialog: ({ userId, organizationId }) =>
    set({ dialog: { status: "open", userId, organizationId } }),
  closeDialog: () => set({ dialog: { status: "closed" } }),
}));
