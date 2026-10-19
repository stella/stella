/** The setup flow as the native side reports it (`onboarding.rs`). */

export const ONBOARDING_STEPS = [
  "welcome",
  "connect",
  "howItWorks",
  "permissions",
  "tryIt",
  "done",
] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export type DocumentApp = {
  iconDataUrl: string | null;
  name: string;
};

export type OnboardingSnapshot = {
  activityAvailable: boolean;
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

export const isOnboardingSnapshot = (
  value: unknown,
): value is OnboardingSnapshot =>
  isRecord(value) &&
  isStep(value["step"]) &&
  Array.isArray(value["steps"]) &&
  value["steps"].every(isStep) &&
  typeof value["linked"] === "boolean" &&
  typeof value["activityAvailable"] === "boolean" &&
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
