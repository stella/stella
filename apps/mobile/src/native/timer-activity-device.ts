import { randomUUID } from "expo-crypto";

import { parseIntegerToken } from "@stll/agent-input/numeric-token";

import type { AccessTokenSource, StoredSession } from "@/connection/session";
import type { BeforeSessionEnd } from "@/connection/session-end";
import { LIVE_ACTIVITIES, PUSH_NOTIFICATIONS } from "@/env";
import { deviceAccountStore } from "@/native/account-store";
import {
  clearTimerActions,
  configureTimerActions,
  TIMER_ACTIONS_AVAILABLE,
} from "@/native/timer-actions";
import { keyPart } from "@/state/recent-searches";
import { unregisterTimerActivityDevice } from "@/state/timer-activity-devices";

/**
 * Whether the server can update this build's timer on the Lock Screen: it
 * needs the Live Activity extension and the push entitlement, which a release
 * signs together.
 */
export const TIMER_ACTIVITY_PUSH = LIVE_ACTIVITIES && PUSH_NOTIFICATIONS;

export type SessionKeys = Pick<
  StoredSession,
  "serverUrl" | "signInId" | "userId"
>;

/** This sign-in's own id for the phone: a new sign-in is a new registration. */
const deviceIdKey = ({ serverUrl, signInId }: SessionKeys) =>
  `timer-activity-device.${keyPart(serverUrl)}.${keyPart(signInId)}`;

/** The number of the registration this sign-in last sent. */
const sequenceKey = ({ serverUrl, signInId }: SessionKeys) =>
  `timer-activity-sequence.${keyPart(serverUrl)}.${keyPart(signInId)}`;

/**
 * The number for this sign-in's next registration: never below one already
 * sent, even after a restart or a clock set back, and otherwise the time,
 * so it keeps growing. Kept on the phone before it is used.
 */
export const nextTimerActivitySequence = async (
  session: SessionKeys,
  now: number,
): Promise<number> => {
  const sent = parseIntegerToken(
    (await deviceAccountStore.read(sequenceKey(session))) ?? "0",
    { sign: "unsigned" },
  ).unwrapOr(0);
  const next = Math.max(sent + 1, now);
  await deviceAccountStore.write(sequenceKey(session), String(next));
  return next;
};

/** When the Lock Screen button key this sign-in holds stops working. */
const actionKeyExpiryKey = ({ serverUrl, signInId }: SessionKeys) =>
  `timer-activity-action-key.${keyPart(serverUrl)}.${keyPart(signInId)}`;

/** A key is renewed once less than this is left of it. */
const ACTION_KEY_RENEW_MS = 6 * 60 * 60 * 1000;

const actionKeyExpiry = async (session: SessionKeys): Promise<number> =>
  parseIntegerToken(
    (await deviceAccountStore.read(actionKeyExpiryKey(session))) ?? "0",
    { sign: "unsigned" },
  ).unwrapOr(0);

/**
 * Whether the Lock Screen buttons work on this phone now: the build can
 * answer them and the sign-in holds a key that has not expired.
 */
export const timerActionsLive = async (
  session: SessionKeys,
  now: number,
): Promise<boolean> =>
  TIMER_ACTIONS_AVAILABLE && (await actionKeyExpiry(session)) > now;

/** Whether the next registration should ask for a new key. */
export const wantsTimerActionKey = async (
  session: SessionKeys,
  now: number,
): Promise<boolean> =>
  TIMER_ACTIONS_AVAILABLE &&
  (await actionKeyExpiry(session)) - now < ACTION_KEY_RENEW_MS;

/**
 * Hands a newly issued key to the native side, which answers the buttons,
 * and notes when it expires. False when the key could not be kept.
 */
export const keepTimerActionKey = async ({
  deviceId,
  expiresAt,
  key,
  session,
}: {
  readonly deviceId: string;
  readonly expiresAt: number;
  readonly key: string;
  readonly session: SessionKeys;
}): Promise<boolean> => {
  if (!configureTimerActions({ deviceId, key, serverUrl: session.serverUrl })) {
    return false;
  }
  await deviceAccountStore.write(
    actionKeyExpiryKey(session),
    String(expiresAt),
  );
  return true;
};

/** The person's own choice, kept for their account on this phone. */
const detailsKey = ({ serverUrl, userId }: SessionKeys) =>
  `timer-activity-details.${keyPart(serverUrl)}.${keyPart(userId)}`;

const pendingIds = new Map<string, Promise<string>>();

/**
 * The id this sign-in registers the phone under, made the first time it is
 * needed. Callers that overlap share one id; a failed write is retried by
 * the next caller.
 */
export const timerActivityDeviceId = async (
  session: SessionKeys,
): Promise<string> => {
  const key = deviceIdKey(session);
  const pending = pendingIds.get(key);
  if (pending !== undefined) {
    return await pending;
  }
  const made = (async () => {
    const stored = await deviceAccountStore.read(key);
    if (stored !== null) {
      return stored;
    }
    const created = randomUUID();
    await deviceAccountStore.write(key, created);
    return created;
  })();
  pendingIds.set(key, made);
  // A failed write lets the next caller try again.
  made.catch(() => pendingIds.delete(key));
  return await made;
};

/** Sign-ins that have signed out, whose registrations must not be sent. */
const signedOut = new Set<string>();

export const isSignedOut = (session: SessionKeys): boolean =>
  signedOut.has(deviceIdKey(session));

const listeners = new Set<() => void>();

/**
 * Whether updates the server sends through Apple may name the timer's
 * description and matter. On until the person turns it off in Settings, for
 * their account alone.
 */
export const readTimerActivityDetails = async (
  session: SessionKeys,
): Promise<boolean> =>
  (await deviceAccountStore.read(detailsKey(session))) !== "off";

export const writeTimerActivityDetails = async (
  session: SessionKeys,
  shown: boolean,
): Promise<void> => {
  await deviceAccountStore.write(detailsKey(session), shown ? "on" : "off");
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
 * Tells the server this sign-in is over on the phone, before the session
 * goes. Registrations still being prepared are dropped, and one already on
 * its way is refused by the server once the sign-out is filed. Best effort:
 * should the request fail, the server stops on its own once a later sign-in
 * here registers, or after two weeks without word from the phone.
 */
export const stopTimerActivityUpdates = async (
  source: AccessTokenSource,
): Promise<void> => {
  const session = source.session();
  if (!TIMER_ACTIVITY_PUSH || session === undefined) {
    return;
  }
  const key = deviceIdKey(session);
  signedOut.add(key);
  // The buttons stop at once, whether or not the server hears of it.
  clearTimerActions();
  const deviceId = await deviceAccountStore.read(key).catch(() => null);
  if (deviceId !== null) {
    (await unregisterTimerActivityDevice({ deviceId, fetch, source })).unwrapOr(
      undefined,
    );
  }
};

/** Deletes the ending sign-in's phone id, so the next sign-in registers anew. */
export const forgetTimerActivityDevice: BeforeSessionEnd = async (
  _reason,
  session,
) => {
  await deviceAccountStore.remove(deviceIdKey(session));
  await deviceAccountStore.remove(sequenceKey(session));
  await deviceAccountStore.remove(actionKeyExpiryKey(session));
};
