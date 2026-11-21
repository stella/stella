import { panic } from "better-result";

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

/** What has to happen before stella desktop can run an action. */
export type DesktopSetupStep = "connect" | "install" | "update";

/** Whether stella desktop can run an action now, or the step that comes first. */
export type DesktopActionStatus =
  { type: "ready" } | { type: "setup"; step: DesktopSetupStep };

export const getDesktopActionStatus = (
  presence: DesktopPresence["type"],
): DesktopActionStatus => {
  switch (presence) {
    case "current": {
      return { type: "ready" };
    }
    case "not_connected": {
      return { type: "setup", step: "connect" };
    }
    case "none": {
      return { type: "setup", step: "install" };
    }
    case "outdated": {
      return { type: "setup", step: "update" };
    }
    default: {
      presence satisfies never;
      return panic(`Unhandled desktop presence: ${String(presence)}`);
    }
  }
};

/** The status line that starts a setup step, shown above the actions it unlocks. */
export const DESKTOP_SETUP_LABELS = {
  connect: "workspaces.files.desktopGate.connect",
  install: "workspaces.files.desktopGate.download",
  update: "workspaces.files.desktopGate.update",
} as const satisfies Record<DesktopSetupStep, TranslationKey>;
