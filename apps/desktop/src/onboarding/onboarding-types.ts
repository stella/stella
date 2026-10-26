/** The setup flow as the native side reports it (`onboarding.rs`). */

import { isPermission } from "../shared/permissions";
import type { Permission } from "../shared/permissions";

export const ONBOARDING_STEPS = [
  "welcome",
  "connect",
  "howItWorks",
  "activity",
  "permissions",
  "tryIt",
  "done",
] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/** The inputs the window sends; the native `Input` also has the shortcut. */
export const ONBOARDING_NAVIGATION = ["continue", "back"] as const;

export type OnboardingNavigation = (typeof ONBOARDING_NAVIGATION)[number];

export type DocumentApp = {
  iconDataUrl: string | null;
  name: string;
};

/** The tour, permissions turned off since, or a feature that arrived later. */
export type OnboardingMode =
  | { type: "tour" }
  | { permissions: Permission[]; type: "fix" }
  | { feature: "activityTimeline"; type: "introduce" };

export type OnboardingSnapshot = {
  activityAvailable: boolean;
  /** Asked on the Activity step; the Permissions step shows the rest. */
  activityPermissions: Permission[];
  mode: OnboardingMode;
  documentApp: DocumentApp | null;
  linked: boolean;
  step: OnboardingStep;
  steps: OnboardingStep[];
};

/** Mirrors `CHANGED_EVENT`; payload-free. */
export const ONBOARDING_CHANGED_EVENT = "onboarding-changed";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStep = (value: unknown): value is OnboardingStep =>
  typeof value === "string" &&
  (ONBOARDING_STEPS as readonly string[]).includes(value);

const isDocumentApp = (value: unknown): value is DocumentApp =>
  isRecord(value) &&
  typeof value["name"] === "string" &&
  (value["iconDataUrl"] === null ||
    (typeof value["iconDataUrl"] === "string" &&
      value["iconDataUrl"].startsWith("data:image/png;base64,")));

const isMode = (value: unknown): value is OnboardingMode => {
  if (!isRecord(value)) {
    return false;
  }
  switch (value["type"]) {
    case "tour":
      return true;
    case "fix":
      return (
        Array.isArray(value["permissions"]) &&
        value["permissions"].every(isPermission)
      );
    case "introduce":
      return value["feature"] === "activityTimeline";
    default:
      return false;
  }
};

export const isOnboardingSnapshot = (
  value: unknown,
): value is OnboardingSnapshot =>
  isRecord(value) &&
  isMode(value["mode"]) &&
  isStep(value["step"]) &&
  Array.isArray(value["steps"]) &&
  value["steps"].every(isStep) &&
  typeof value["linked"] === "boolean" &&
  typeof value["activityAvailable"] === "boolean" &&
  Array.isArray(value["activityPermissions"]) &&
  value["activityPermissions"].every(isPermission) &&
  (value["documentApp"] === null || isDocumentApp(value["documentApp"]));

/**
 * What setup tells the user it never asks for. Each entry is bound by
 * `tests/never-requested.test.ts` to the declarations and native calls that
 * would contradict it, so the list cannot outlive the truth.
 */
export const NEVER_REQUESTED = {
  mac: [
    "screenRecording",
    "microphone",
    "camera",
    "keystrokes",
    "fullDiskAccess",
  ],
  other: ["screenRecording", "microphone", "camera", "keystrokes"],
  windows: [
    "screenRecording",
    "microphone",
    "camera",
    "keystrokes",
    "administrator",
  ],
} as const;

export type NeverRequested =
  (typeof NEVER_REQUESTED)[keyof typeof NEVER_REQUESTED][number];
