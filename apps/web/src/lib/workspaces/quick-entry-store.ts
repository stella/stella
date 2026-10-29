import type { RefObject } from "react";

import { create } from "zustand";

import { captureDialogReturnFocus } from "@/lib/dialog-return-focus";

type QuickEntryScope = { userId: string; organizationId: string };
type QuickEntryState = {
  dialog:
    { status: "closed" } | ({ status: "open" | "closing" } & QuickEntryScope);
  returnFocus: RefObject<HTMLElement | null>;
  openDialog: (scope: QuickEntryScope & { opener?: HTMLElement }) => void;
  closeDialog: () => void;
  finishClosing: () => void;
};

export const useQuickEntryStore = create<QuickEntryState>()((set) => ({
  dialog: { status: "closed" },
  returnFocus: { current: null },
  openDialog: ({ userId, organizationId, opener }) =>
    set({
      dialog: { status: "open", userId, organizationId },
      returnFocus: captureDialogReturnFocus(opener),
    }),
  closeDialog: () =>
    set(({ dialog }) =>
      dialog.status === "open"
        ? {
            dialog: {
              status: "closing",
              userId: dialog.userId,
              organizationId: dialog.organizationId,
            },
          }
        : {},
    ),
  finishClosing: () =>
    set(({ dialog }) =>
      dialog.status === "closing" ? { dialog: { status: "closed" } } : {},
    ),
}));
