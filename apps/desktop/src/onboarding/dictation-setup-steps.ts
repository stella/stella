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

/** Where `screen` sits in `screens`, or the first screen when it no longer
 *  applies: the screen after it took its place. */
const positionOf = (
  screens: readonly DictationSetupScreen[],
  screen: DictationSetupScreen,
) => {
  const index = screens.indexOf(screen);
  if (index !== -1) {
    return index;
  }
  // A screen can stop applying while it is shown, such as More context when
  // cleanup is turned off in Settings; the next one that applies takes over.
  const order = DICTATION_SETUP_SCREENS.indexOf(screen);
  const next = screens.findIndex(
    (candidate) => DICTATION_SETUP_SCREENS.indexOf(candidate) > order,
  );
  return next === -1 ? screens.length - 1 : next;
};

type DictationSetupMove =
  | { screen: DictationSetupScreen; type: "screen" }
  /** Before the first screen: the step before Dictation. */
  | { type: "leaveBack" }
  /** After the last screen: the step after Dictation. */
  | { type: "leaveForward" };

/** Where Back or Continue goes from `screen`. */
export const moveFrom = (
  screens: readonly DictationSetupScreen[],
  screen: DictationSetupScreen,
  direction: "back" | "continue",
): DictationSetupMove => {
  const index = positionOf(screens, screen);
  const order = (candidate: DictationSetupScreen | undefined) =>
    candidate === undefined ? -1 : DICTATION_SETUP_SCREENS.indexOf(candidate);
  // The first screen after `screen`: the next one, or, when `screen`
  // stopped applying, the one that took its place if it comes later.
  const after = order(screens[index]) > order(screen) ? index : index + 1;
  // The last screen before it.
  const before = screens[index] === screen ? index - 1 : after - 1;
  const next = screens[direction === "continue" ? after : before];
  if (next !== undefined) {
    return { screen: next, type: "screen" };
  }
  return direction === "continue"
    ? { type: "leaveForward" }
    : { type: "leaveBack" };
};

/** The screen shown for `screen` now: itself, or the one that took its
 *  place when it stopped applying. */
export const shownScreen = (
  screens: readonly DictationSetupScreen[],
  screen: DictationSetupScreen,
): DictationSetupScreen =>
  screens[positionOf(screens, screen)] ?? DICTATION_SETUP_SCREENS[0];
