import { create } from "zustand";

export type MatterDraftClient = {
  id: string;
  displayName: string;
  type: "person" | "organization";
};

type CreateMatterState = {
  isOpen: boolean;
  draftClient: MatterDraftClient | null;
  closeDialog: () => void;
  openDialog: (client?: MatterDraftClient) => void;
};

export const useCreateMatterStore = create<CreateMatterState>()((set) => ({
  isOpen: false,
  draftClient: null,
  closeDialog: () =>
    set({
      isOpen: false,
      draftClient: null,
    }),
  openDialog: (client) =>
    set({
      isOpen: true,
      draftClient: client ?? null,
    }),
}));
