import { panic } from "better-result";

import { type Clock, systemClock } from "./clock.ts";

/**
 * Event-based waits. A test waits for the thing that happened (an event, a
 * resolved deferred, an observable state), never for an amount of time. The
 * only deadline is a hang guard that reports what was awaited; it is never an
 * assertion about speed.
 */

/** Hang guard: below the repository's 30 s per-test cap so the reason prints. */
export const DEFAULT_WAIT_TIMEOUT_MS = 20_000;

export class WaitTimeoutError extends Error {
  override readonly name = "WaitTimeoutError";
  readonly description: string;

  constructor(description: string, timeoutMs: number) {
    super(`Timed out after ${timeoutMs} ms waiting for ${description}`);
    this.description = description;
  }
}

export type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  /** True once resolve or reject has been called. */
  settled: () => boolean;
};

/** A promise a test settles by hand: the signal one side waits for. */
export const deferred = <T = void>(): Deferred<T> => {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  let done = false;
  return {
    promise,
    resolve: (value) => {
      done = true;
      resolve(value);
    },
    reject: (reason) => {
      done = true;
      reject(reason);
    },
    settled: () => done,
  };
};

type HangGuard = {
  /** What is awaited, phrased to finish "waiting for …". */
  description: string;
  timeoutMs?: number;
  clock?: Clock;
};

const TIMED_OUT = Symbol("timed out");
const SETTLED = Symbol("settled");

const guard = async <T>(
  awaited: Promise<T>,
  {
    description,
    timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
    clock = systemClock,
  }: HangGuard,
): Promise<T> => {
  const stop = new AbortController();
  // Once the awaited promise wins, the timer is aborted with SETTLED; any
  // other rejection is a real failure and propagates.
  const timer = clock.sleep(timeoutMs, { signal: stop.signal }).then(
    () => TIMED_OUT,
    (error: unknown) => {
      if (error !== SETTLED) {
        throw error;
      }
      return SETTLED;
    },
  );
  try {
    const first = await Promise.race([
      awaited.then((value) => ({ value })),
      timer,
    ]);
    if (typeof first === "symbol") {
      throw new WaitTimeoutError(description, timeoutMs);
    }
    return first.value;
  } finally {
    stop.abort(SETTLED);
  }
};

/** Waits for a promise to settle, failing with `description` if it hangs. */
export const settledWithin = async <T>(
  promise: Promise<T>,
  options: HangGuard,
): Promise<T> => guard(promise, options);

/** Resolves with the next `type` event on `target`. */
export const waitForEvent = async (
  target: EventTarget,
  type: string,
  options: Partial<HangGuard> = {},
): Promise<Event> => {
  const { promise, resolve } = Promise.withResolvers<Event>();
  const listener = (event: Event) => resolve(event);
  target.addEventListener(type, listener, { once: true });
  return guard(promise, {
    description: `a "${type}" event`,
    ...options,
  }).finally(() => target.removeEventListener(type, listener));
};

/** Resolves with the signal's reason once it aborts. */
export const waitForAbort = async (
  signal: AbortSignal,
  options: Partial<HangGuard> = {},
): Promise<unknown> => {
  if (!signal.aborted) {
    await waitForEvent(signal, "abort", {
      description: "the signal to abort",
      ...options,
    });
  }
  const reason: unknown = signal.reason;
  return reason;
};

type WaitForOptions = HangGuard & {
  /** Re-check spacing on `clock`; observation cadence, not a deadline. */
  intervalMs?: number;
};

/**
 * Re-checks `probe` until it returns a value other than `undefined`, then
 * resolves with it. For state that has no event to subscribe to (a database
 * row, a file appearing). Prefer `deferred`/`waitForEvent` when the code can
 * signal. A throwing probe fails the wait at once.
 */
export const waitFor = async <T>(
  probe: () => T | undefined | Promise<T | undefined>,
  {
    description,
    intervalMs = 10,
    timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
    clock = systemClock,
  }: WaitForOptions,
): Promise<T> => {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    panic("waitFor intervalMs must be a positive number");
  }
  // The hang guard covers a probe that never settles too; once it fires, the
  // loop stops at its next step and a late probe failure is not reported twice.
  const stop = new AbortController();
  const poll = async (): Promise<{ value: T } | typeof SETTLED> => {
    for (;;) {
      const value = await probe();
      if (stop.signal.aborted) {
        return SETTLED;
      }
      if (value !== undefined) {
        return { value };
      }
      const woke = await clock.sleep(intervalMs, { signal: stop.signal }).then(
        () => true,
        (error: unknown) => {
          if (error !== SETTLED) {
            throw error;
          }
          return false;
        },
      );
      if (!woke) {
        return SETTLED;
      }
    }
  };
  const polling = poll().then(
    (outcome) => outcome,
    (error: unknown) => {
      if (stop.signal.aborted) {
        return SETTLED;
      }
      throw error;
    },
  );
  try {
    const outcome = await guard(polling, { clock, description, timeoutMs });
    // SETTLED is only returned after `stop` aborts, which happens below.
    return typeof outcome === "symbol"
      ? panic("waitFor resolved after it stopped")
      : outcome.value;
  } finally {
    stop.abort(SETTLED);
  }
};
