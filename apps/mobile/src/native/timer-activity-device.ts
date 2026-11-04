import { randomUUID } from "expo-crypto";

import type { AccessTokenSource } from "@/connection/session";
import { LIVE_ACTIVITIES, PUSH_NOTIFICATIONS } from "@/env";
import { deviceAccountStore } from "@/native/account-store";
import { unregisterTimerActivityDevice } from "@/state/timer-activity-devices";

/**
 * Whether the server can update this build's timer on the Lock Screen: it
 * needs the Live Activity extension and the push entitlement, which a release
 * signs together.
 */
export const TIMER_ACTIVITY_PUSH = LIVE_ACTIVITIES && PUSH_NOTIFICATIONS;

const DEVICE_ID_KEY = "timer-activity-device";
const DETAILS_KEY = "timer-activity-details";

/**
 * The id this phone registers its timer under, made the first time and kept
 * until the app is removed. It names a phone, not a person: when somebody
 * else signs in here, their registration is the one the server follows.
 */
export const timerActivityDeviceId = async (): Promise<string> => {
  const stored = await deviceAccountStore.read(DEVICE_ID_KEY);
  if (stored !== null) {
    return stored;
  }
  const created = randomUUID();
  await deviceAccountStore.write(DEVICE_ID_KEY, created);
  return created;
};

const listeners = new Set<() => void>();

/**
 * Whether updates the server sends through Apple may name the timer's
 * description and matter. On until the person turns it off in Settings.
 */
export const readTimerActivityDetails = async (): Promise<boolean> =>
  (await deviceAccountStore.read(DETAILS_KEY)) !== "off";

export const writeTimerActivityDetails = async (
  shown: boolean,
): Promise<void> => {
  await deviceAccountStore.write(DETAILS_KEY, shown ? "on" : "off");
  for (const listener of listeners) {
    listener();
  }
};

/** Calls `listener` after the person changes the setting; returns its removal. */
export const onTimerActivityDetailsChange = (
  listener: () => void,
): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/**
 * Tells the server to stop updating this phone's timer, as the person signs
 * out. Best effort: should it fail, a later sign-in here claims the phone,
 * and the server follows the newer claim.
 */
export const stopTimerActivityUpdates = async (
  source: AccessTokenSource,
): Promise<void> => {
  if (!TIMER_ACTIVITY_PUSH) {
    return;
  }
  const deviceId = await deviceAccountStore
    .read(DEVICE_ID_KEY)
    .catch(() => null);
  if (deviceId !== null) {
    (await unregisterTimerActivityDevice({ deviceId, fetch, source })).unwrapOr(
      undefined,
    );
  }
};
