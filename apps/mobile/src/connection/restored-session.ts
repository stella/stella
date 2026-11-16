// The session the app starts with, read from the keychain once per launch.
// Its token source lives here, outside any component, so every render of the
// session provider shares it (see `restoredSource`).

import { Result } from "better-result";

import { epochMilliseconds } from "@/connection/clock";
import { deviceInstallMarker, deviceSessionStore } from "@/connection/platform";
import { createAccessTokenSource } from "@/connection/session";
import type {
  AccessToken,
  AccessTokenSource,
  SessionGeneration,
  StoredSession,
} from "@/connection/session";
import { restoreSession } from "@/connection/session-actions";
import {
  createSessionEndBoundary,
  type SessionEndBoundary,
} from "@/connection/session-end";
import { revokeRefreshToken } from "@/connection/tokens";
import { deviceAccountStore } from "@/native/account-store";
import { clearTimerActions } from "@/native/timer-actions";
import { forgetTimerActivityDevice } from "@/native/timer-activity-device";
import { forgetRecentSearches } from "@/state/recent-searches";

/**
 * Every sign-out's last word on the device: what the app keeps there for
 * the account goes with its session.
 */
export const createDeviceSessionEnd = (): SessionEndBoundary => {
  const boundary = createSessionEndBoundary();
  boundary.register(forgetRecentSearches(deviceAccountStore));
  boundary.register(forgetTimerActivityDevice);
  return boundary;
};

/** Gives a grant back to the server. Best effort: an unrevoked grant expires unused. */
export const revokeSession = async (session: StoredSession) => {
  (
    await revokeRefreshToken({
      clientId: session.clientId,
      fetch,
      refreshToken: session.refreshToken,
      revocationEndpoint: session.revocationEndpoint,
    })
  ).unwrapOr(undefined);
};

/** How long a reinstalled app's first launch waits for the old grant's revocation. */
const REINSTALL_REVOKE_WAIT_MS = 2000;

/**
 * The session a previous run kept, read once as the app starts. A keychain
 * that cannot be read (the device locked during a background launch) starts
 * signed out; signing in writes a fresh session over whatever was there.
 */
const restoredGeneration = deviceSessionStore.generation();
const restoredSession: Promise<StoredSession | undefined> = Result.tryPromise(
  async () =>
    await restoreSession({
      store: deviceSessionStore,
      generation: restoredGeneration,
      marker: deviceInstallMarker,
      // A session an earlier installation kept has no screen, recording or
      // Live Activity in this one, so the sign-out clears only what the
      // device keeps: the account's items and the Lock Screen buttons' key.
      // The server drops this phone's push and timer registrations on its
      // own, as after any sign-out whose requests fail.
      beforeEnd: async (session) => {
        await createDeviceSessionEnd().run("signed-out", session);
        // Best effort, as every session-end handler is.
        Result.try(() => {
          clearTimerActions();
        }).unwrapOr(undefined);
      },
      // The launch waits on the network only briefly: a slower revocation,
      // which never rejects, carries on while the sign-in screen opens.
      revoke: async (session) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          revokeSession(session),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, REINSTALL_REVOKE_WAIT_MS);
          }),
        ]);
        clearTimeout(timer);
      },
    }),
).then((read) => (Result.isOk(read) ? read.value : undefined));

type SourceOptions = {
  readonly session: StoredSession;
  readonly initialAccess: AccessToken | undefined;
  readonly generation: SessionGeneration;
};

export const sourceFor = ({
  session,
  initialAccess,
  generation,
}: SourceOptions): AccessTokenSource =>
  createAccessTokenSource({
    fetch,
    generation,
    initialAccess,
    now: epochMilliseconds,
    session,
    store: deviceSessionStore,
  });

/**
 * The restored session's token source, made once for every render: React may
 * render the provider more than once before it mounts, and two sources would
 * each refresh the same rotating grant, so one would be refused and end it.
 */
export const restoredSource: Promise<AccessTokenSource | undefined> =
  restoredSession.then((session) =>
    session === undefined
      ? undefined
      : sourceFor({
          session,
          initialAccess: undefined,
          generation: restoredGeneration,
        }),
  );
