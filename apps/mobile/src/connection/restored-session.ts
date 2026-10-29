// The session the app starts with, read from the keychain once per launch.
// Its token source lives here, outside any component, so every render of the
// session provider shares it (see `restoredSource`).

import { Result } from "better-result";

import { epochMilliseconds } from "@/connection/clock";
import { deviceSessionStore } from "@/connection/platform";
import { createAccessTokenSource } from "@/connection/session";
import type {
  AccessToken,
  AccessTokenSource,
  SessionGeneration,
  StoredSession,
} from "@/connection/session";

/**
 * The session a previous run kept, read once as the app starts. A keychain
 * that cannot be read (the device locked during a background launch) starts
 * signed out; signing in writes a fresh session over whatever was there.
 */
const restoredGeneration = deviceSessionStore.generation();
const restoredSession: Promise<StoredSession | undefined> = Result.tryPromise(
  async () => await deviceSessionStore.read(restoredGeneration),
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
