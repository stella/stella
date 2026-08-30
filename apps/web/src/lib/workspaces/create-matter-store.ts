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
    | {
        status: "open";
        draftClient: MatterDraftClient | null;
        onCreated?: (workspaceId: string) => void | Promise<void>;
      };
  closeDialog: () => void;
  openDialog: (
    client?: MatterDraftClient,
    onCreated?: (workspaceId: string) => void | Promise<void>,
  ) => void;
};

export const useCreateMatterStore = create<CreateMatterState>()((set) => ({
  dialog: { status: "closed" },
  closeDialog: () =>
    set({
      dialog: { status: "closed" },
    }),
  openDialog: (client, onCreated) =>
    set({
      dialog: {
        status: "open",
        draftClient: client ?? null,
        ...(onCreated ? { onCreated } : {}),
      },
    }),
}));
