import type { DesktopPresence } from "@stll/api-contract/desktop-presence";

import type { TranslationKey } from "@/i18n/types";

/** Work that stella desktop can do for a file. */
export type DesktopAction = "edit-file" | "sign-pdf";

export const DESKTOP_ACTION_LABELS = {
  "edit-file": {
    current: "workspaces.files.desktopEdit.openAction",
    none: "workspaces.files.desktopGate.editNone",
    not_connected: "workspaces.files.desktopGate.connect",
    outdated: "workspaces.files.desktopGate.editOutdated",
  },
  "sign-pdf": {
    current: "workspaces.files.desktopGate.signCurrent",
    none: "workspaces.files.desktopGate.signNone",
    not_connected: "workspaces.files.desktopGate.connect",
    outdated: "workspaces.files.desktopGate.signOutdated",
  },
} as const satisfies Record<
  DesktopAction,
  Record<DesktopPresence["type"], TranslationKey>
>;

/** Why the action needs the desktop app, shown before installing it. */
export const DESKTOP_ACTION_REASONS = {
  "edit-file": "workspaces.files.desktopGate.editReason",
  "sign-pdf": "workspaces.files.desktopGate.signReason",
} as const satisfies Record<DesktopAction, TranslationKey>;
