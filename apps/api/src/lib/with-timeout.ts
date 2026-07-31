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
 * way to cancel every underlying API, so callers must still be safe to retry.
 * Operations that support cancellation should consume the provided signal;
 * other work may still complete server-side after the wrapper rejects.
 */
export const withTimeout = async <T>(
  operation: (signal: AbortSignal) => Promise<T>,
  { label, signal, timeoutMs }: WithTimeoutOptions,
): Promise<T> => {
  signal?.throwIfAborted();
  const operationController = new AbortController();
  const op = Promise.resolve().then(
    async () => await operation(operationController.signal),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadlines: Promise<never>[] = [];
  if (timeoutMs > 0) {
    deadlines.push(
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
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

  try {
    return await Promise.race([op, ...deadlines]);
  } finally {
    clearTimeout(timer);
    if (signal !== undefined && abort !== undefined) {
      signal.removeEventListener("abort", abort);
    }
    // Cancellation is cooperative: operations that use the provided signal
    // stop their underlying work. Keep swallowing late settlement for APIs
    // that cannot cancel so their rejection is never reported as unhandled.
    op.catch(() => undefined);
  }
};
