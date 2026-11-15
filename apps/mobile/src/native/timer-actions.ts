import { requireOptionalNativeModule } from "expo";

type TimerActionsModule = {
  configure: (serverUrl: string, deviceId: string, key: string) => boolean;
  clear: () => void;
};

/**
 * The native side that answers the Lock Screen's timer buttons
 * (`modules/timer-actions`); null in a build without it.
 */
const timerActions =
  requireOptionalNativeModule<TimerActionsModule>("TimerActions");

/**
 * Hands the native side the key its buttons act with, kept in the keychain.
 * False when this build cannot answer the buttons, or the key was not kept.
 */
export const configureTimerActions = ({
  deviceId,
  key,
  serverUrl,
}: {
  readonly deviceId: string;
  readonly key: string;
  readonly serverUrl: string;
}): boolean => timerActions?.configure(serverUrl, deviceId, key) ?? false;

/** Takes the key back, as the person signs out. */
export const clearTimerActions = (): void => {
  timerActions?.clear();
};

/** Whether this build can answer the buttons at all. */
export const TIMER_ACTIONS_AVAILABLE = timerActions !== null;
