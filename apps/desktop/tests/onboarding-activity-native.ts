import { mockIPC } from "@tauri-apps/api/mocks";
import { panic } from "better-result";

import type { DesktopBillingDraftSettingsResponse } from "@stll/api-contract/desktop-billing-drafts";

import type { OnboardingSnapshot } from "../src/onboarding/onboarding-types";
import type { ActivitySetupSnapshot } from "../src/onboarding/use-activity-setup";
import type { PermissionsSnapshot } from "../src/shared/permissions";

/**
 * A native side for the setup window's Activity screens: it answers from
 * the state it holds, applies the activity and drafting commands to it as
 * the native side and the server do, and records every command the window
 * sends.
 */

export const ACTIVITY_OFF = {
  captureDetails: true,
  detailsAccess: "accessibilityRequired",
  detectCalls: true,
  recordingStatus: "off",
} as const satisfies ActivitySetupSnapshot;

const ACTIVITY_STEP = {
  activityAvailable: true,
  activityPermissions: ["accessibility"],
  dictationAvailable: false,
  dictationPermissions: [],
  documentApp: null,
  linked: true,
  mode: { type: "tour" },
  step: "activity",
  steps: ["welcome", "howItWorks", "activity", "permissions", "done"],
  trayLocation: null,
} as const satisfies OnboardingSnapshot;

export const ACTIVITY_INTRODUCTION = {
  ...ACTIVITY_STEP,
  mode: { feature: "activityTimeline", type: "introduce" },
  step: "welcome",
} as const satisfies OnboardingSnapshot;

const PERMISSION_ROWS = {
  rows: [
    { permission: "notifications", status: "granted" },
    { permission: "accessibility", status: "notDetermined" },
  ],
} satisfies PermissionsSnapshot;

export const SCOPE_KEY = '["org_fixture","user_fixture"]';

export const DRAFTS_OFFERED = {
  consent: "revoked",
  effectiveMode: "plain",
  preference: null,
  revision: "revision-1",
} as const satisfies DesktopBillingDraftSettingsResponse;

export type NativeSide = {
  activity: ActivitySetupSnapshot;
  /** While set, reading the activity state fails. */
  activityUnreadable: boolean;
  drafts: DesktopBillingDraftSettingsResponse;
  onboarding: OnboardingSnapshot;
  calls: { args: unknown; command: string }[];
};

export const nativeSide = (
  overrides: Partial<Omit<NativeSide, "calls">> = {},
): NativeSide => ({
  activity: ACTIVITY_OFF,
  activityUnreadable: false,
  calls: [],
  drafts: DRAFTS_OFFERED,
  onboarding: ACTIVITY_STEP,
  ...overrides,
});

const argument = (args: unknown, name: string): unknown =>
  typeof args === "object" && args !== null
    ? Object.entries(args).find(([key]) => key === name)?.[1]
    : undefined;

const enabled = (args: unknown) => {
  const value = argument(args, "enabled");
  return typeof value === "boolean" ? value : panic("enabled is required");
};

/** Applies one activity change the way the native side stores it. */
const changedActivity = (
  activity: ActivitySetupSnapshot,
  command: string,
  args: unknown,
): ActivitySetupSnapshot => {
  switch (command) {
    case "activity_set_recording_status": {
      const status = argument(args, "status");
      return status === "recording" || status === "paused"
        ? { ...activity, recordingStatus: status }
        : panic("activity recording can only be paused");
    }
    case "activity_set_capture_details":
      return { ...activity, captureDetails: enabled(args) };
    case "activity_set_detect_calls":
      return { ...activity, detectCalls: enabled(args) };
    default:
      return panic(`unexpected activity command ${command}`);
  }
};

const scoped = (settings: DesktopBillingDraftSettingsResponse) => ({
  scopeKey: SCOPE_KEY,
  settings,
});

export const installNativeSide = (native: NativeSide) => {
  mockIPC(
    (command, args) => {
      native.calls.push({ args, command });
      switch (command) {
        case "onboarding_get_snapshot":
        case "onboarding_advance":
          return native.onboarding;
        case "permissions_get_snapshot":
          return PERMISSION_ROWS;
        case "activity_get_setup":
          if (native.activityUnreadable) {
            panic("the activity state cannot be read");
          }
          return native.activity;
        case "activity_set_recording_status":
        case "activity_set_capture_details":
        case "activity_set_detect_calls":
          native.activity = changedActivity(native.activity, command, args);
          return null;
        case "billing_draft_get_settings":
          return scoped(native.drafts);
        case "billing_draft_grant_consent":
          native.drafts = { ...native.drafts, consent: "granted" };
          return scoped(native.drafts);
        case "billing_draft_withdraw_consent":
          native.drafts = { ...native.drafts, consent: "revoked" };
          return scoped(native.drafts);
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
