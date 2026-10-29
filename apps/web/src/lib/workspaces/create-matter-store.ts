import type { RefObject } from "react";

import { create } from "zustand";

import type { ContactType } from "@stll/api-contract";

import { captureDialogReturnFocus } from "@/lib/dialog-return-focus";

export type MatterDraftClient = {
  id: string;
  displayName: string;
  type: ContactType;
};

type OpenCreateMatterOptions = {
  client?: MatterDraftClient;
  onCreated?: (workspaceId: string) => void | Promise<void>;
  opener?: HTMLElement;
};

type CreateMatterState = {
  dialog:
    | { status: "closed" }
    | {
        status: "open" | "closing";
        draftClient: MatterDraftClient | null;
        onCreated?: (workspaceId: string) => void | Promise<void>;
      };
  returnFocus: RefObject<HTMLElement | null>;
  closeDialog: () => void;
  finishClosing: () => void;
  openDialog: (options?: OpenCreateMatterOptions) => void;
};

export const useCreateMatterStore = create<CreateMatterState>()((set) => ({
  dialog: { status: "closed" },
  returnFocus: { current: null },
  closeDialog: () =>
    set(({ dialog }) => {
      if (dialog.status !== "open") {
        return {};
      }
      return {
        dialog: {
          status: "closing",
          draftClient: dialog.draftClient,
          ...(dialog.onCreated ? { onCreated: dialog.onCreated } : {}),
        },
      };
    }),
  finishClosing: () =>
    set(({ dialog }) =>
      dialog.status === "closing" ? { dialog: { status: "closed" } } : {},
    ),
  openDialog: ({ client, onCreated, opener } = {}) =>
    set({
      returnFocus: captureDialogReturnFocus(opener),
      dialog: {
        status: "open",
        draftClient: client ?? null,
        ...(onCreated ? { onCreated } : {}),
      },
    }),
}));
