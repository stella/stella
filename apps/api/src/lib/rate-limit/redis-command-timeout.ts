import { TimeoutError } from "@/api/lib/errors/tagged-errors";

/**
 * Bound every Redis command so a slow or unreachable Redis cannot stall the
 * caller. Bun's RedisClient has no built-in command timeout, so we race the
 * command against a timer and reject with a `TimeoutError` if it does not
 * resolve in time. Callers race this against their fallback path.
 *
 * The timer is injectable (`scheduleTimeout` returns a cancel function) so
 * tests can drive the timeout deterministically; the default uses
 * `setTimeout`.
 */
export type ScheduleTimeout = (
  callback: () => void,
  delayMs: number,
) => () => void;

export const defaultScheduleTimeout: ScheduleTimeout = (callback, delayMs) => {
  const timeoutId = setTimeout(callback, delayMs);
  return () => clearTimeout(timeoutId);
};

type WithCommandTimeoutOptions<T> = {
  command: Promise<T>;
  commandTimeoutMs: number;
  /** `label` on the emitted `TimeoutError`, identifying the calling context. */
  label: string;
  scheduleTimeout?: ScheduleTimeout;
};

export const withCommandTimeout = async <T>({
  command,
  commandTimeoutMs,
  label,
  scheduleTimeout = defaultScheduleTimeout,
}: WithCommandTimeoutOptions<T>): Promise<T> => {
  let cancelTimeout: () => void = () => undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    cancelTimeout = scheduleTimeout(
      () =>
        reject(
          new TimeoutError({
            label,
            message: "Redis command timed out",
            timeoutMs: commandTimeoutMs,
          }),
        ),
      commandTimeoutMs,
    );
  });
  return await Promise.race([command, timeout]).finally(cancelTimeout);
};
