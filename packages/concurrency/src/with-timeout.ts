// parser-output-unchanged: an injectable deadline timer defaults to setTimeout, so no parser output changes.
import { TaggedError } from "better-result";

/** Timeout waiting for an asynchronous operation or external resource. */
export class TimeoutError extends TaggedError("TimeoutError")<{
  message: string;
  label: string;
  timeoutMs?: number;
  cause?: unknown;
}> {}

/**
 * Starts the deadline timer and returns its cancel function. Tests inject one
 * to fire the deadline at a chosen point instead of racing the wall clock.
 */
export type WithTimeoutScheduler = (
  callback: () => void,
  delayMs: number,
) => () => void;

const defaultScheduleTimeout: WithTimeoutScheduler = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
};

type WithTimeoutOptions = {
  label: string;
  signal?: AbortSignal | undefined;
  timeoutMs: number;
  scheduleTimeout?: WithTimeoutScheduler | undefined;
};

/**
 * Races an async operation against a wall-clock deadline and optional abort
 * signal. If the deadline passes first, rejects with a TimeoutError instead of
 * waiting forever.
 *
 * The motivating case is a DB read on a pooled connection that the
 * server reaped silently (no RST): Bun's SQL client never settles the
 * query promise, so the await hangs indefinitely. There is no portable
 * way to cancel every underlying API, so callers must still be safe to retry.
 * Operations that support cancellation should consume the provided signal;
 * other work may still complete server-side after the wrapper rejects.
 */
export const withTimeout = async <T>(
  operation: (signal: AbortSignal) => Promise<T>,
  {
    label,
    signal,
    timeoutMs,
    scheduleTimeout = defaultScheduleTimeout,
  }: WithTimeoutOptions,
): Promise<T> => {
  signal?.throwIfAborted();
  const operationController = new AbortController();
  const op = Promise.resolve().then(
    async () => await operation(operationController.signal),
  );
  let cancelTimer: () => void = () => undefined;
  const deadlines: Promise<never>[] = [];
  if (timeoutMs > 0) {
    deadlines.push(
      new Promise<never>((_resolve, reject) => {
        cancelTimer = scheduleTimeout(() => {
          const error = new TimeoutError({
            message: `${label} exceeded ${timeoutMs}ms`,
            label,
            timeoutMs,
          });
          operationController.abort(error);
          reject(error);
        }, timeoutMs);
      }),
    );
  }

  let abort: (() => void) | undefined;
  if (signal !== undefined) {
    deadlines.push(
      new Promise<never>((_resolve, reject) => {
        abort = () => {
          const reason =
            signal.reason instanceof Error
              ? signal.reason
              : new DOMException("The operation was aborted.", "AbortError");
          operationController.abort(reason);
          reject(reason);
        };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) {
          abort();
        }
      }),
    );
  }

  // Cancellation is cooperative, so an operation that ignores the signal can
  // still reject after a deadline wins. The race's own subscription to `op`
  // observes that late rejection, so it never surfaces as unhandled.
  try {
    return await Promise.race([op, ...deadlines]);
  } finally {
    cancelTimer();
    if (signal !== undefined && abort !== undefined) {
      signal.removeEventListener("abort", abort);
    }
  }
};
