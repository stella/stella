import { panic } from "better-result";

/** A read that has not observed the awaited state yet. */
type NotYet = false | null | undefined;

export type ExternalStateWait<T, Fallback> = {
  /** The awaited state, named in the failure: "backend 42 waits on a lock". */
  description: string;
  /** Reads the state once. `false`, `null` or `undefined` means not yet. */
  read: () => Promise<T | NotYet> | T | NotYet;
  /** Pause between reads. */
  intervalMs?: number;
  /** Budget for the whole wait. */
  timeoutMs?: number;
  /** The result once the budget is spent; without it the wait fails the test. */
  onTimeout?: () => Fallback;
};

const DEFAULT_INTERVAL_MS = 10;
const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Waits for state that lives outside this process and announces no event: a
 * lock wait in another database session, a child process exiting, a file a
 * child writes, a server becoming ready. Returns the first read that holds.
 *
 * State this process owns has a milestone to await instead (a promise the
 * code under test resolves, an event it emits, a store subscription), and the
 * `test-timing/no-polling-loop` lint rule rejects polling it in tests.
 * This module is the one place such a loop lives.
 */
export const waitForExternalState = async <T, Fallback = never>({
  description,
  read,
  intervalMs = DEFAULT_INTERVAL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  onTimeout,
}: ExternalStateWait<T, Fallback>): Promise<T | Fallback> => {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const state = await read();
    if (state !== false && state !== null && state !== undefined) {
      return state;
    }
    if (performance.now() >= deadline) {
      return onTimeout === undefined
        ? panic(
            `Waited ${String(timeoutMs)} ms, but ${description} never held. Check that the step that causes it ran, or raise timeoutMs if it is slow on purpose.`,
          )
        : onTimeout();
    }
    await Bun.sleep(intervalMs);
  }
};
