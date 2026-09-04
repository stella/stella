import { connectionErrorFields } from "@/api/lib/errors/utils";
import { logger } from "@/api/lib/observability/logger";
import {
  isRecoverableRedisPollError,
  isTransientRedisConnectionError,
} from "@/api/lib/redis-error-classification";

/**
 * A BullMQ worker's `error` event fires once per failed blocking poll, and a
 * Redis disruption fails every poll on every worker at once. Logging each
 * occurrence turns a transient into millions of identical lines that bury
 * every other record in the log group for exactly the window an operator
 * needs to read it, and make the error-rate metric report the retry rate
 * rather than the number of faults.
 *
 * Every code suppressed here is one this codebase already classifies as an
 * expected operational transient rather than a defect (`redis-client.ts`), so
 * the tally, not the occurrence, is the signal. Severity stays ERROR: a real
 * outage must still cross the error-rate alarm; only its volume is bounded.
 */
const TRANSIENT_LOG_INTERVAL_MS = 60 * 1000;

const isSuppressibleRedisError = (error: unknown): boolean =>
  isTransientRedisConnectionError(error) || isRecoverableRedisPollError(error);

/**
 * Build the `worker.on("error")` handler for one queue worker.
 *
 * Each worker gets its own counters: they describe that worker's connection,
 * and sharing them across queues would let a busy worker's interval silence a
 * quiet one's first report.
 */
export const createQueueWorkerErrorLogger = (
  event: string,
  fields: Record<string, string> = {},
): ((error: unknown) => void) => {
  let suppressedSinceLastLog = 0;
  let lastLoggedAtMs = 0;
  let pendingFlush: ReturnType<typeof setTimeout> | null = null;
  let lastSuppressedError: unknown = undefined;

  const report = (error: unknown, nowMs: number): void => {
    lastLoggedAtMs = nowMs;
    const occurrences = suppressedSinceLastLog;
    suppressedSinceLastLog = 0;
    logger.error(event, {
      ...connectionErrorFields(error),
      ...fields,
      // Reported as "since the last line" rather than a running total so two
      // consecutive lines describe two disjoint intervals.
      occurrencesSinceLastLog: String(occurrences),
    });
  };

  return (error: unknown): void => {
    if (!isSuppressibleRedisError(error)) {
      logger.error(event, { ...connectionErrorFields(error), ...fields });
      return;
    }
    suppressedSinceLastLog += 1;
    lastSuppressedError = error;
    const nowMs = Date.now();
    const sinceLastLog = nowMs - lastLoggedAtMs;
    // The first transient of an episode reports immediately: `lastLoggedAtMs`
    // starts at 0, so the interval has always elapsed. Without that the onset
    // of an outage would be invisible for a whole interval.
    if (sinceLastLog >= TRANSIENT_LOG_INTERVAL_MS) {
      if (pendingFlush !== null) {
        clearTimeout(pendingFlush);
        pendingFlush = null;
      }
      report(error, nowMs);
      return;
    }
    if (pendingFlush !== null) {
      return;
    }
    // A disruption that stops inside the interval would otherwise strand every
    // occurrence after the leading line, so a short outage of thousands would
    // report "1" forever. The trailing flush is what makes the tally the
    // signal rather than the first sample; it is unref'd so a pending count
    // can never hold the process open at shutdown.
    pendingFlush = setTimeout(() => {
      pendingFlush = null;
      if (suppressedSinceLastLog === 0) {
        return;
      }
      report(lastSuppressedError, Date.now());
    }, TRANSIENT_LOG_INTERVAL_MS - sinceLastLog);
    pendingFlush.unref();
  };
};
