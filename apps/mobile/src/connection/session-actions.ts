import { Result } from "better-result";

import { TokenError } from "./errors";
import type { SessionGeneration, SessionStore, StoredSession } from "./session";

type SignOutOptions = {
  readonly store: SessionStore;
  readonly session: StoredSession | undefined;
  readonly revoke: (session: StoredSession) => Promise<void>;
  readonly publish: (generation: SessionGeneration) => void;
};

export const signOutSession = async ({
  store,
  session,
  revoke,
  publish,
}: SignOutOptions) => {
  const transition = store.begin();
  if (session !== undefined) {
    await revoke(session);
  }
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
