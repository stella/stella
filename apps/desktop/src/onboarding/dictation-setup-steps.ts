/**
 * The screens the Dictation step walks through, in order, and which of them
 * apply. The native flow knows only the one Dictation step; these screens
 * live inside it, so they follow the live dictation state: a screen whose
 * setting would change nothing is left out, the way Settings → Dictation
 * hides or dims the same rows.
 */

import { panic } from "better-result";

import type { Permission } from "../shared/permissions";
import type { DesktopPlatform } from "../shared/shortcut-keys";

export const DICTATION_SETUP_SCREENS = [
  "microphone",
  "transcription",
  "app",
  "context",
  "words",
] as const;

export type DictationSetupScreen = (typeof DICTATION_SETUP_SCREENS)[number];

/** Where speech is transcribed, as the native destination names it. */
export type DictationDestinationChoice = "local" | "cloud";

/** The parts of the dictation state that decide which screens apply. */
export type DictationSetupState = {
  cleanup: boolean;
  /** Whether the account has stella AI transcription at all. */
  cloudAvailable: boolean;
  destination: DictationDestinationChoice;
};

/**
 * The screens that apply now, in order. More context is read only by AI
 * cleanup, so it goes with cleanup off; custom words reach only stella AI
 * transcription and AI cleanup, so they go with neither.
 */
export const dictationSetupScreens = (
  state: DictationSetupState,
): DictationSetupScreen[] =>
  DICTATION_SETUP_SCREENS.filter((screen) => {
    switch (screen) {
      case "microphone":
      case "transcription":
      case "app":
        return true;
      case "context":
        return state.cleanup;
      case "words":
        return state.cleanup || state.destination === "cloud";
      default:
        screen satisfies never;
        return panic("Unknown dictation setup screen.");
    }
  });

/** The choices the transcription screen offers: stella AI only for an
 *  account that has it, or one already transcribing with it. */
export const transcriptionChoices = (
  state: Pick<DictationSetupState, "cloudAvailable" | "destination">,
): DictationDestinationChoice[] =>
  state.cloudAvailable || state.destination === "cloud"
    ? ["local", "cloud"]
    : ["local"];

/**
 * The permissions the microphone screen asks for: the microphone, then
 * Accessibility to type the text, which only macOS gates.
 */
export const microphoneScreenPermissions = (
  permissions: readonly Permission[],
  platform: DesktopPlatform,
): Permission[] =>
  (["microphone", "accessibility"] as const).filter(
    (permission) =>
      permissions.includes(permission) &&
      (permission !== "accessibility" || platform === "mac"),
  );
