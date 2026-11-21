import { requireOptionalNativeModule } from "expo";
import type { EventEmitter, EventSubscription } from "expo";

/** The system took the microphone (a call, Siri, an alarm), or gave it back. */
export type DictationInterruption = { readonly phase: "began" | "ended" };

type DictationDeviceEvents = {
  onInterruption: (event: DictationInterruption) => void;
  /** The microphone a dictation recorded from went away, as AirPods put back in their case. */
  onInputLost: () => void;
};

type DictationDeviceModule = EventEmitter<DictationDeviceEvents> & {
  routeForDictation: (builtInMicrophone: boolean) => void;
  releaseRoute: () => void;
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
}: DictationDeviceEvents): EventSubscription[] =>
  device === null
    ? []
    : [
        device.addListener("onInterruption", onInterruption),
        device.addListener("onInputLost", onInputLost),
      ];

/** Whether this build chooses the microphone itself, so Settings offers the choice. */
export const DICTATION_ROUTE_AVAILABLE = device !== null;
