import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

import { KEYBOARD_DICTATION } from "@/env";
import {
  DICTATION_CHUNK_RULES,
  DICTATION_TOTAL_MAX_MS,
} from "@/state/dictation-chunks";
import {
  parseKeyboardPieces,
  parseKeyboardStatus,
} from "@/state/keyboard-dictation";
import type {
  KeepWarm,
  KeyboardLanguage,
  KeyboardLayout,
  KeyboardOutcome,
  KeyboardPiece,
  KeyboardStatus,
} from "@/state/keyboard-dictation";

type KeyboardDictationEvents = {
  /** Pieces are waiting in `takeCaptures`. */
  onCapture: () => void;
  /** The session's state changed. */
  onStatus: () => void;
};

/**
 * `modules/keyboard-dictation`, the app's half of the stella keyboard. As
 * every Expo module, it is an event emitter.
 */
type KeyboardDictationModule = {
  addListener: (
    event: keyof KeyboardDictationEvents,
    listener: () => void,
  ) => { remove: () => void };
  configure: (group: string) => boolean;
  setKeepWarm: (seconds: number) => boolean;
  setLayout: (layout: string) => boolean;
  start: (
    warmSeconds: number,
    rules: {
      minimumMs: number;
      maximumMs: number;
      silenceDb: number;
      pauseMs: number;
      totalMaxMs: number;
    },
  ) => string;
  end: () => void;
  claimHandoff: (jobId: string, language: string) => boolean;
  startCapture: (jobId: string, language: string) => boolean;
  stopCapture: (jobId: string) => boolean;
  cancelCapture: (jobId: string) => boolean;
  deliver: (jobId: string, outcome: string, text: string | null) => boolean;
  takeCaptures: () => unknown;
  status: () => unknown;
};

let resolved: { module: KeyboardDictationModule | null } | undefined;

/**
 * The native session, configured with the build's App Group; null in a
 * build without the keyboard (Android, or a release that leaves it out).
 */
const keyboardDictation = (): KeyboardDictationModule | null => {
  if (resolved === undefined) {
    const native =
      Platform.OS === "ios" && KEYBOARD_DICTATION !== null
        ? requireOptionalNativeModule<KeyboardDictationModule>(
            "KeyboardDictation",
          )
        : null;
    resolved = {
      module:
        native !== null &&
        KEYBOARD_DICTATION !== null &&
        native.configure(KEYBOARD_DICTATION.appGroup)
          ? native
          : null,
    };
  }
  return resolved.module;
};

/** Whether this build carries the stella keyboard at all. */
export const keyboardDictationAvailable = (): boolean =>
  keyboardDictation() !== null;

/** How opening the microphone for the keyboard went. */
export type KeyboardSessionStart = "started" | "denied" | "failed";

/**
 * Opens the microphone for the keyboard, kept warm for `keepWarm` seconds
 * after each dictation, with the composer's rules for cutting a long one
 * into pieces. Microphone permission is asked for before this.
 */
export const startKeyboardSession = (
  keepWarm: KeepWarm,
): KeyboardSessionStart => {
  const started = keyboardDictation()?.start(keepWarm, {
    ...DICTATION_CHUNK_RULES,
    totalMaxMs: DICTATION_TOTAL_MAX_MS,
  });
  return started === "started" || started === "denied" ? started : "failed";
};

export const endKeyboardSession = (): void => {
  keyboardDictation()?.end();
};

/**
 * Whether the keyboard itself left this dictation in the App Group just
 * before it opened the app; true once, as the claim consumes it.
 */
export const claimKeyboardHandoff = (
  jobId: string,
  language: KeyboardLanguage,
): boolean => keyboardDictation()?.claimHandoff(jobId, language) ?? false;

/** Starts the dictation a keyboard link named; false when one is under way already. */
export const startKeyboardCapture = (
  jobId: string,
  language: KeyboardLanguage,
): boolean => keyboardDictation()?.startCapture(jobId, language) ?? false;

export const stopKeyboardCapture = (jobId: string): boolean =>
  keyboardDictation()?.stopCapture(jobId) ?? false;

export const cancelKeyboardCapture = (jobId: string): boolean =>
  keyboardDictation()?.cancelCapture(jobId) ?? false;

/** Hands the dictation's outcome to the keyboard; false when it was cancelled meanwhile. */
export const deliverKeyboardOutcome = (
  jobId: string,
  outcome: KeyboardOutcome,
): boolean =>
  keyboardDictation()?.deliver(
    jobId,
    outcome.type,
    outcome.type === "text" ? outcome.text : null,
  ) ?? false;

/** The recorded pieces waiting for transcription, each handed over once. */
export const takeKeyboardPieces = (): KeyboardPiece[] => {
  const native = keyboardDictation();
  return native === null ? [] : parseKeyboardPieces(native.takeCaptures());
};

/** The session and the keyboard's last run; null in a build without the keyboard. */
export const readKeyboardStatus = (): KeyboardStatus | null => {
  const native = keyboardDictation();
  return native === null ? null : parseKeyboardStatus(native.status());
};

/** Keeps the choice in the App Group; a session under way takes it at once. */
export const setKeepWarm = (seconds: KeepWarm): boolean =>
  keyboardDictation()?.setKeepWarm(seconds) ?? false;

/** Keeps the keyboard's letter layout in the App Group, for it to read as it next appears. */
export const setKeyboardLayout = (layout: KeyboardLayout): boolean =>
  keyboardDictation()?.setLayout(layout) ?? false;

/** Calls `listener` on the session's event; returns the unsubscribe. */
export const onKeyboardDictation = (
  event: keyof KeyboardDictationEvents,
  listener: () => void,
): (() => void) => {
  const subscription = keyboardDictation()?.addListener(event, listener);
  return () => {
    subscription?.remove();
  };
};
