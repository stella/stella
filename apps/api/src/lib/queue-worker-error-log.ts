import { Temporal } from "@stll/time";

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
 * the tally, not the occurrence, is the signal. Severity grades the episode by
 * how long it has lasted: reports inside the grace window below are WARN,
 * because a Redis instance being replaced fails every poll on every worker for
 * a minute or two and then heals itself; an episode still reporting past the
 * grace is ERROR and crosses the error-rate signal as before. The tally
 * semantics are unchanged at either severity.
 */
const TRANSIENT_LOG_INTERVAL_MS = 60 * 1000;

/**
 * How long a transient episode may last before its reports count as errors.
 * The window has to cover a self-healing replacement (one to three minutes of
 * failed polls) without turning it into an error-rate signal; the price is
 * that a genuine outage is graded ERROR this much after it starts.
 */
const TRANSIENT_GRACE_MS = 120 * 1000;

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
  let lastSuppressedAtMs = 0;
  let episodeStartedAtMs = 0;
  let pendingFlush: ReturnType<typeof setTimeout> | null = null;
  let lastSuppressedError: unknown = undefined;

  const report = (error: unknown, nowMs: number): void => {
    lastLoggedAtMs = nowMs;
    const occurrences = suppressedSinceLastLog;
    suppressedSinceLastLog = 0;
    // Measured to the last counted occurrence rather than to now, so the
    // trailing flush grades the failures it summarizes and not the interval it
    // waited out: an episode that healed inside the grace stays a WARN even
    // though its flush lands after the grace.
    const episodeAgeMs = lastSuppressedAtMs - episodeStartedAtMs;
    const attributes = {
      ...connectionErrorFields(error),
      ...fields,
      // Reported as "since the last line" rather than a running total so two
      // consecutive lines describe two disjoint intervals.
      occurrencesSinceLastLog: String(occurrences),
      // Carries the reason for the severity, so a WARN line and the ERROR
      // line that follows it in the same episode are readable as one run.
      episodeAgeMs: String(episodeAgeMs),
    };
    if (episodeAgeMs < TRANSIENT_GRACE_MS) {
      logger.warn(event, attributes);
      return;
    }
    logger.error(event, attributes);
  };

  return (error: unknown): void => {
    if (!isSuppressibleRedisError(error)) {
      logger.error(event, { ...connectionErrorFields(error), ...fields });
      return;
    }
    suppressedSinceLastLog += 1;
    lastSuppressedError = error;
    const nowMs = Temporal.Now.instant().epochMilliseconds;
    // There is no "recovered" event, so an episode is a run of transients with
    // no gap longer than the log interval: a worker that stopped reporting for
    // that long was polling successfully again, and the next failure is a new
    // disruption entitled to its own grace. The first ever call starts an
    // episode for free, because `lastSuppressedAtMs` starts at 0.
    if (nowMs - lastSuppressedAtMs > TRANSIENT_LOG_INTERVAL_MS) {
      episodeStartedAtMs = nowMs;
    }
    lastSuppressedAtMs = nowMs;
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
      report(lastSuppressedError, Temporal.Now.instant().epochMilliseconds);
    }, TRANSIENT_LOG_INTERVAL_MS - sinceLastLog);
    pendingFlush.unref();
  };
};
