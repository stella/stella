import { requireOptionalNativeModule } from "expo";
import type { EventSubscription } from "expo";
import * as v from "valibot";

/** Where a dictation started outside the app stands. */
const PHASES = ["idle", "recording", "finished"] as const;
export type QuickDictationPhase = (typeof PHASES)[number];

const phaseSchema = v.picklist(PHASES);

type QuickDictationModule = {
  addListener: (
    eventName: "onChange",
    listener: (event: { phase: string }) => void,
  ) => EventSubscription;
  configure: (configuration: string) => boolean;
  clear: () => Promise<void>;
  phase: () => Promise<string>;
  take: () => Promise<string[] | null>;
  discard: () => Promise<void>;
  copy: (text: string) => Promise<void>;
};

/**
 * The native side that records a dictation for the Action Button, Siri,
 * Shortcuts and Control Center (`modules/quick-dictation`); null in a build
 * without it.
 */
const quickDictation =
  requireOptionalNativeModule<QuickDictationModule>("QuickDictation");

/** Whether this build can record a dictation started outside the app. */
export const QUICK_DICTATION_AVAILABLE = quickDictation !== null;

/**
 * Hands the native side what a press needs while the app is not running
 * (`quickDictationConfiguration`). False when this build cannot record one
 * or the configuration was refused.
 */
export const configureQuickDictation = (configuration: object): boolean =>
  quickDictation?.configure(JSON.stringify(configuration)) ?? false;

/** At sign-out: presses stop recording, and whatever was recorded is deleted. */
export const clearQuickDictation = async (): Promise<void> => {
  await quickDictation?.clear();
};

export const quickDictationPhase = async (): Promise<QuickDictationPhase> => {
  if (quickDictation === null) {
    return "idle";
  }
  return v.parse(phaseSchema, await quickDictation.phase());
};

/** Tells `onPhase` each time the dictation's phase changes. */
export const watchQuickDictation = (
  onPhase: (phase: QuickDictationPhase) => void,
): EventSubscription | null =>
  quickDictation?.addListener("onChange", ({ phase }) => {
    onPhase(v.parse(phaseSchema, phase));
  }) ?? null;

/**
 * The finished dictation's recordings, in spoken order, finishing one still
 * recording first; null when there is none. They stay on the phone until
 * `discardQuickDictation`.
 */
export const takeQuickDictation = async (): Promise<readonly string[] | null> =>
  (await quickDictation?.take()) ?? null;

export const discardQuickDictation = async (): Promise<void> => {
  await quickDictation?.discard();
};

/** Puts text on the clipboard; false in a build that cannot. */
export const copyText = async (text: string): Promise<boolean> => {
  if (quickDictation === null) {
    return false;
  }
  await quickDictation.copy(text);
  return true;
};
