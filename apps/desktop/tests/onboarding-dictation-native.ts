import { mockIPC } from "@tauri-apps/api/mocks";
import { panic } from "better-result";

import type { OnboardingSnapshot } from "../src/onboarding/onboarding-types";
import type { DictationSnapshot } from "../src/onboarding/use-dictation";
import type { PermissionsSnapshot } from "../src/shared/permissions";

/**
 * A native side for the setup window's dictation screens: it answers from
 * the snapshots it holds, applies the dictation commands to them as the
 * native side does, and records every command the window sends.
 */

export const DICTATION_OFF = {
  available: true,
  enabled: false,
  failure: null,
  keys: { code: "Space", modifiers: ["control", "alt"] },
  model: { status: "missing" },
  modelBytes: 740_363_168,
  phase: "idle",
  shortcutTaken: false,
} satisfies DictationSnapshot;

export const DICTATION_STEP = {
  activityAvailable: false,
  activityPermissions: [],
  dictationAvailable: true,
  dictationPermissions: ["microphone", "accessibility"],
  documentApp: null,
  linked: true,
  mode: { type: "tour" },
  step: "dictation",
  steps: ["welcome", "howItWorks", "tryIt", "dictation", "done"],
  trayLocation: null,
} satisfies OnboardingSnapshot;

const PERMISSION_ROWS = {
  rows: [
    { permission: "notifications", status: "granted" },
    { permission: "accessibility", status: "notDetermined" },
    { permission: "microphone", status: "notDetermined" },
  ],
} satisfies PermissionsSnapshot;

export type NativeSide = {
  /** The dictation snapshot, or what a native side without it answers. */
  dictation: DictationSnapshot | { available: false };
  onboarding: OnboardingSnapshot;
  calls: { args: unknown; command: string }[];
};

export const nativeSide = (
  overrides: Partial<Omit<NativeSide, "calls">> = {},
): NativeSide => ({
  calls: [],
  dictation: DICTATION_OFF,
  onboarding: DICTATION_STEP,
  ...overrides,
});

const enabledArgument = (args: unknown) =>
  typeof args === "object" &&
  args !== null &&
  "enabled" in args &&
  args.enabled === true;

export const installNativeSide = (native: NativeSide) => {
  mockIPC(
    (command, args) => {
      native.calls.push({ args, command });
      const dictation = native.dictation;
      switch (command) {
        case "onboarding_get_snapshot":
        case "onboarding_advance":
          return native.onboarding;
        case "permissions_get_snapshot":
          return PERMISSION_ROWS;
        case "dictation_get_snapshot":
          return dictation;
        case "dictation_set_enabled":
          if (!("enabled" in dictation)) {
            panic("dictation is not available on this computer");
          }
          native.dictation = { ...dictation, enabled: enabledArgument(args) };
          return native.dictation;
        case "dictation_download_model":
          if (!("enabled" in dictation)) {
            panic("dictation is not available on this computer");
          }
          native.dictation = {
            ...dictation,
            model: { received: 0, status: "downloading", total: 740_363_168 },
          };
          return native.dictation;
        default:
          return null;
      }
    },
    { shouldMockEvents: true },
  );
};

/** The commands the window sent, in order, without event plumbing. */
export const sentCommands = (native: NativeSide) =>
  native.calls
    .map(({ command }) => command)
    .filter((command) => !command.startsWith("plugin:"));
