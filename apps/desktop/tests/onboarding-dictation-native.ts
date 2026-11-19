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
  cleanup: true,
  cloudAvailable: false,
  cloudModel: null,
  customWords: [],
  destination: "local",
  enabled: false,
  failure: null,
  holdKey: "combination",
  keys: { code: "Space", modifiers: ["control", "alt"] },
  model: { status: "missing" },
  modelBytes: 740_363_168,
  phase: "idle",
  shareTextBeforeCursor: false,
  shareWindowTitle: false,
  shortcutTaken: false,
  textBeforeCursorAvailable: true,
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

/** The region's stella AI models, one of them from a provider that keeps
 *  the audio. */
const CLOUD_MODELS = {
  defaultModelId: "mistralai/voxtral-mini-transcribe",
  models: [
    {
      displayName: "Voxtral Mini Transcribe",
      id: "mistralai/voxtral-mini-transcribe",
      outsideRegion: false,
      provider: "Mistral AI",
      retainsData: false,
    },
    {
      displayName: "Scribe v3",
      id: "elevenlabs-direct/scribe-v3",
      outsideRegion: true,
      provider: "ElevenLabs",
      retainsData: true,
    },
  ],
  unavailable: null,
};

export type NativeSide = {
  /** The dictation snapshot, or what a native side without it answers. */
  dictation: DictationSnapshot | { available: false };
  /** While set, reading the dictation snapshot fails. */
  dictationUnreadable: boolean;
  onboarding: OnboardingSnapshot;
  calls: { args: unknown; command: string }[];
};

export const nativeSide = (
  overrides: Partial<Omit<NativeSide, "calls">> = {},
): NativeSide => ({
  calls: [],
  dictation: DICTATION_OFF,
  dictationUnreadable: false,
  onboarding: DICTATION_STEP,
  ...overrides,
});

const enabledArgument = (args: unknown) =>
  typeof args === "object" &&
  args !== null &&
  "enabled" in args &&
  args.enabled === true;

const argument = (args: unknown, name: string): unknown =>
  typeof args === "object" && args !== null
    ? Object.entries(args).find(([key]) => key === name)?.[1]
    : undefined;

/** Applies one dictation change the way the native side stores it. */
const changed = (
  dictation: DictationSnapshot,
  command: string,
  args: unknown,
): DictationSnapshot | null => {
  switch (command) {
    case "dictation_set_enabled":
      return { ...dictation, enabled: enabledArgument(args) };
    case "dictation_set_cleanup":
      return { ...dictation, cleanup: enabledArgument(args) };
    case "dictation_set_share_window_title":
      return { ...dictation, shareWindowTitle: enabledArgument(args) };
    case "dictation_set_share_text_before_cursor":
      return { ...dictation, shareTextBeforeCursor: enabledArgument(args) };
    case "dictation_set_destination": {
      const destination = argument(args, "destination");
      if (destination === "cloud" && !dictation.cloudAvailable) {
        return panic("stella AI transcription is not available");
      }
      return destination === "cloud" || destination === "local"
        ? { ...dictation, destination }
        : panic("unknown destination");
    }
    case "dictation_set_cloud_model": {
      const modelId = argument(args, "modelId");
      return typeof modelId === "string"
        ? { ...dictation, cloudModel: modelId }
        : panic("unknown model");
    }
    case "dictation_set_custom_words": {
      const words = argument(args, "words");
      return Array.isArray(words) &&
        words.every((word) => typeof word === "string")
        ? { ...dictation, customWords: words }
        : panic("unknown words");
    }
    case "dictation_download_model":
      return {
        ...dictation,
        model: { received: 0, status: "downloading", total: 740_363_168 },
      };
    default:
      return null;
  }
};

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
          if (native.dictationUnreadable) {
            panic("the dictation state cannot be read");
          }
          return dictation;
        case "dictation_get_cloud_models":
          return CLOUD_MODELS;
        default: {
          if (!command.startsWith("dictation_")) {
            return null;
          }
          if (!("enabled" in dictation)) {
            return panic("dictation is not available on this computer");
          }
          const next = changed(dictation, command, args);
          if (next === null) {
            return null;
          }
          native.dictation = next;
          return next;
        }
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
