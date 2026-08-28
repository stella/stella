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
 * Both codes suppressed here are ones this codebase already classifies as
 * expected operational transients rather than defects (`redis-client.ts`), so
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
  return (error: unknown): void => {
    if (!isSuppressibleRedisError(error)) {
      logger.error(event, { ...connectionErrorFields(error), ...fields });
      return;
    }
    suppressedSinceLastLog += 1;
    const nowMs = Date.now();
    // The first transient of an episode reports immediately: `lastLoggedAtMs`
    // starts at 0, so the interval has always elapsed. Without that the onset
    // of an outage would be invisible for a whole interval.
    if (nowMs - lastLoggedAtMs < TRANSIENT_LOG_INTERVAL_MS) {
      return;
    }
    lastLoggedAtMs = nowMs;
    logger.error(event, {
      ...connectionErrorFields(error),
      ...fields,
      // Reported as "since the last line" rather than a running total so two
      // consecutive lines describe two disjoint intervals.
      occurrencesSinceLastLog: String(suppressedSinceLastLog),
    });
    suppressedSinceLastLog = 0;
  };
};
