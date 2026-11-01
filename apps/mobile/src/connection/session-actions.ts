import { Result } from "better-result";

import { TokenError } from "./errors";
import type { SessionGeneration, SessionStore, StoredSession } from "./session";

type KeepSignInOptions = {
  readonly store: SessionStore;
  readonly transition: ReturnType<SessionStore["begin"]>;
  readonly session: StoredSession;
  readonly revoke: (session: StoredSession) => Promise<void>;
  readonly publish: (generation: SessionGeneration) => void;
};

/**
 * Stores a new sign-in's grant and publishes it. A grant the app does not
 * adopt (the keychain refused it, or a later sign-in or sign-out took over)
 * is one nobody will use, so it goes back to the server.
 */
export const keepSignIn = async ({
  store,
  transition,
  session,
  revoke,
  publish,
}: KeepSignInOptions): Promise<Result<void, TokenError>> => {
  const stored = await Result.tryPromise({
    try: async () => await transition.write(session),
    catch: (cause) =>
      new TokenError({ message: "The keychain refused the session", cause }),
  });
  const adopted =
    Result.isOk(stored) &&
    stored.value.type === "committed" &&
    store.isCurrent(stored.value.generation)
      ? stored.value.generation
      : undefined;
  if (adopted === undefined) {
    await revoke(session);
    return Result.isError(stored)
      ? Result.err(stored.error)
      : Result.ok(undefined);
  }
  store.commit(adopted, () => publish(adopted));
  return Result.ok(undefined);
};

type SignOutOptions = {
  readonly store: SessionStore;
  readonly session: StoredSession | undefined;
  readonly beforeEnd: (session: StoredSession) => Promise<void>;
  readonly revoke: (session: StoredSession) => Promise<void>;
  readonly publish: (generation: SessionGeneration) => void;
};

export const signOutSession = async ({
  store,
  session,
  beforeEnd,
  revoke,
  publish,
}: SignOutOptions) => {
  const generation = store.generation();
  if (session !== undefined) {
    await beforeEnd(session);
    await revoke(session);
  }
  // Cleanup uses the current grant; a later sign-in owns any replacement.
  if (!store.isCurrent(generation)) {
    return Result.ok(undefined);
  }
  const transition = store.begin();
  const cleared = await Result.tryPromise({
    try: async () => await transition.clear(),
    catch: (cause) =>
      new TokenError({ message: "The keychain kept the session", cause }),
  });
  if (Result.isError(cleared)) {
    return Result.err(cleared.error);
  }
  const outcome = cleared.value;
  if (outcome.type === "committed") {
    store.commit(outcome.generation, () => publish(outcome.generation));
  }
  return Result.ok(undefined);
};
