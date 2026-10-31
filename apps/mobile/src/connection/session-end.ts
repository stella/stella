// The one boundary every session-ending path crosses before the app forgets
// the session: features that hold work for the person (a dictation being
// recorded) finish it while they still know whose it is.

import type { StoredSession } from "./session";

/** `signed-out`: the person chose to; `ended`: the server refused the session. */
type SessionEndReason = "signed-out" | "ended";

export type BeforeSessionEnd = (
  reason: SessionEndReason,
  session: StoredSession,
) => Promise<void>;

/** How long the boundary waits for one handler; it never blocks sign-out. */
const BEFORE_SESSION_END_TIMEOUT_MS = 2000;

export type SessionEndBoundary = {
  /** Adds a handler; the returned function removes it again. */
  readonly register: (handler: BeforeSessionEnd) => () => void;
  /**
   * Runs every handler at once and resolves when each has finished, failed
   * or run out of time. A failure is the handler's to report; the session
   * ends either way.
   */
  readonly run: (
    reason: SessionEndReason,
    session: StoredSession,
  ) => Promise<void>;
};

export const createSessionEndBoundary = (
  timeoutMs = BEFORE_SESSION_END_TIMEOUT_MS,
): SessionEndBoundary => {
  const handlers = new Set<BeforeSessionEnd>();

  const bounded = async (
    handler: BeforeSessionEnd,
    reason: SessionEndReason,
    session: StoredSession,
  ): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    // Neither promise rejects: the registered wrapper turns a throw into a
    // rejection, and the catch settles it.
    await Promise.race([
      handler(reason, session).catch(() => undefined),
      timedOut,
    ]);
    clearTimeout(timer);
  };

  return {
    register: (handler) => {
      // A wrapper per registration, so registering one function twice
      // still runs it twice and each unregister removes only its own.
      const registered: BeforeSessionEnd = async (reason, session) => {
        await handler(reason, session);
      };
      handlers.add(registered);
      return () => {
        handlers.delete(registered);
      };
    },
    run: async (reason, session) => {
      await Promise.all(
        [...handlers].map(
          async (handler) => await bounded(handler, reason, session),
        ),
      );
    },
  };
};
