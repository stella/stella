import { TimeoutError } from "@/api/lib/errors/tagged-errors";

type WithTimeoutOptions = {
  label: string;
  timeoutMs: number;
};

/**
 * Races an async operation against a wall-clock deadline. If the
 * deadline passes first, rejects with a TimeoutError instead of
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
  { label, timeoutMs }: WithTimeoutOptions,
): Promise<T> => {
  const op = operation();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new TimeoutError({
          message: `${label} exceeded ${timeoutMs}ms`,
          label,
          timeoutMs,
        }),
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([op, timeout]);
  } finally {
    clearTimeout(timer);
    // If the timeout won the race, `op` is still pending; swallow its
    // eventual settlement so a late rejection is not reported as an
    // unhandled rejection.
    void op.catch(() => undefined);
  }
};
