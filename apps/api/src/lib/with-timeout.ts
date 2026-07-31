import { TimeoutError } from "@/api/lib/errors/tagged-errors";

type WithTimeoutOptions = {
  label: string;
  signal?: AbortSignal | undefined;
  timeoutMs: number;
};

/**
 * Races an async operation against a wall-clock deadline and optional abort
 * signal. If the deadline passes first, rejects with a TimeoutError instead of
 * waiting forever.
 *
 * The motivating case is a DB read on a pooled connection that the
 * server reaped silently (no RST): Bun's SQL client never settles the
 * query promise, so the await hangs indefinitely. There is no portable
 * way to cancel the underlying query, so the operation is abandoned,
 * not aborted — callers must be safe to retry, because the work may
 * still complete server-side.
 */
export const withTimeout = async <T>(
  operation: () => Promise<T>,
  { label, signal, timeoutMs }: WithTimeoutOptions,
): Promise<T> => {
  signal?.throwIfAborted();
  if (timeoutMs === 0 && signal === undefined) {
    return await operation();
  }

  const op = operation();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadlines: Promise<never>[] = [];
  if (timeoutMs > 0) {
    deadlines.push(
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new TimeoutError({
              message: `${label} exceeded ${timeoutMs}ms`,
              label,
              timeoutMs,
            }),
          );
        }, timeoutMs);
      }),
    );
  }

  let abort: (() => void) | undefined;
  if (signal !== undefined) {
    deadlines.push(
      new Promise<never>((_resolve, reject) => {
        abort = () =>
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new DOMException("The operation was aborted.", "AbortError"),
          );
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) {
          abort();
        }
      }),
    );
  }

  try {
    return await Promise.race([op, ...deadlines]);
  } finally {
    clearTimeout(timer);
    if (signal !== undefined && abort !== undefined) {
      signal.removeEventListener("abort", abort);
    }
    // If a deadline won the race, `op` is still pending; swallow its eventual
    // settlement so a late rejection is not reported as unhandled.
    op.catch(() => undefined);
  }
};
