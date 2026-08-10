import { create } from "zustand";

import type { ContactType } from "@stll/api-contract";

export type MatterDraftClient = {
  id: string;
  displayName: string;
  type: ContactType;
};

type CreateMatterState = {
  dialog:
    | { status: "closed" }
    | { status: "open"; draftClient: MatterDraftClient | null };
  closeDialog: () => void;
  openDialog: (client?: MatterDraftClient) => void;
};

export const useCreateMatterStore = create<CreateMatterState>()((set) => ({
  dialog: { status: "closed" },
  closeDialog: () =>
    set({
      dialog: { status: "closed" },
    }),
  openDialog: (client) =>
    set({
      dialog: { status: "open", draftClient: client ?? null },
    }),
}));
