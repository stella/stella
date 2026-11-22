import { requireOptionalNativeModule } from "expo";
import type { EventEmitter, EventSubscription } from "expo";

/** The system took the microphone (a call, Siri, an alarm), or gave it back. */
type DictationInterruption = { readonly phase: "began" | "ended" };

type DictationDeviceEvents = {
  onInterruption: (event: DictationInterruption) => void;
  /** The microphone a dictation recorded from went away, as AirPods put back in their case. */
  onInputLost: () => void;
  onNetworkChange: (event: { readonly online: boolean }) => void;
};

type DictationDeviceModule = EventEmitter<DictationDeviceEvents> & {
  routeForDictation: (builtInMicrophone: boolean) => void;
  releaseRoute: () => void;
  keptFolder: () => string;
  tap: () => void;
};

/**
 * The native side of a dictation's audio (`modules/dictation-device`); null
 * on Android, the web and a build without it, where the recorder's own
 * session applies.
 */
const device =
  requireOptionalNativeModule<DictationDeviceModule>("DictationDevice");

/**
 * Routes the prepared recorder: alongside other apps' audio, with
 * Bluetooth headphones kept on music quality, and from the iPhone's own
 * microphone when `builtInMicrophone`. Runs after each prepare, which
 * resets the session to the recorder's options.
 */
export const routeForDictation = (builtInMicrophone: boolean): void => {
  device?.routeForDictation(builtInMicrophone);
};

/** Lets go of the iPhone's microphone once the dictation has ended. */
export const releaseDictationRoute = (): void => {
  device?.releaseRoute();
};

/**
 * Hears when the system interrupts the microphone or the one recorded from
 * goes away; removing the returned subscriptions stops listening.
 */
export const watchDictationDevice = ({
  onInterruption,
  onInputLost,
}: Pick<
  DictationDeviceEvents,
  "onInterruption" | "onInputLost"
>): EventSubscription[] =>
  device === null
    ? []
    : [
        device.addListener("onInterruption", onInterruption),
        device.addListener("onInputLost", onInputLost),
      ];

/** Whether this build chooses the microphone itself, so Settings offers the choice. */
export const DICTATION_ROUTE_AVAILABLE = device !== null;

/**
 * Hears each change between online and offline, the current state first;
 * null in a build that cannot tell.
 */
export const watchNetwork = (
  onChange: (online: boolean) => void,
): EventSubscription | null =>
  device?.addListener("onNetworkChange", ({ online }) => {
    onChange(online);
  }) ?? null;

/**
 * The folder kept dictations wait in (`native/kept-dictation-files`), as a
 * file URL; null in a build without one of its own.
 */
export const keptDictationFolder = (): string | null =>
  device?.keptFolder() ?? null;

/** A light tap the person feels as a dictation starts and stops; nothing in a build without it. */
export const tapForDictation = (): void => {
  device?.tap();
};
