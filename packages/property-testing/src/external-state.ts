import { panic, Result } from "better-result";
import { readFileSync } from "node:fs";

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

export type FileContentWait<T, Fallback> = Omit<
  ExternalStateWait<T, Fallback>,
  "read"
> & {
  /** The file another process writes to announce a state. */
  path: string;
  /**
   * Reads the content seen so far. A writer creates the file before it writes
   * its content, so an existing file may still be empty or partial: return
   * `undefined` until the content is complete. Like any read here, `false` and
   * `null` also mean "not yet", so return the parsed state in a form that is
   * neither. A writer that ends its content with a terminator (a newline)
   * lets `parse` tell complete content from a cut-off prefix.
   */
  parse: (content: string) => T | undefined;
};

/**
 * Waits for a file another process writes, and returns its parsed content.
 * The file existing is not the announcement: content only counts once
 * `parse` accepts it.
 */
export const waitForFileContent = async <T, Fallback = never>({
  path,
  parse,
  ...wait
}: FileContentWait<T, Fallback>): Promise<T | Fallback> =>
  waitForExternalState({
    ...wait,
    read: () => {
      const content = Result.try(() => readFileSync(path, "utf-8"));
      if (content.isOk()) {
        return parse(content.value);
      }
      const cause = content.error.cause;
      if (
        cause instanceof Error &&
        "code" in cause &&
        cause.code === "ENOENT"
      ) {
        return undefined;
      }
      return panic(`Cannot read ${path}`, cause);
    },
  });
