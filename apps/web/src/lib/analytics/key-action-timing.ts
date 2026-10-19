import type { Analytics, KeyActionMeasure } from "@/lib/analytics/types";

// Upper bounds, in milliseconds, of the buckets a measured duration is
// reported in. Coarse enough that a duration says nothing about the content
// behind it, fine enough that p50/p95 over the bound tracks real speed.
export const KEY_ACTION_DURATION_BUCKETS_MS = [
  100, 250, 500, 750, 1000, 1500, 2000, 3000, 5000, 7500, 10_000, 15_000,
  20_000, 30_000, 60_000, 120_000,
] as const;

export type KeyActionDurationBucketMs =
  | (typeof KEY_ACTION_DURATION_BUCKETS_MS)[number]
  // Above the last bound: the action ran longer than any bucket names.
  | typeof KEY_ACTION_DURATION_OVERFLOW_MS;

export const KEY_ACTION_DURATION_OVERFLOW_MS = 120_001;

/** The smallest bucket bound the duration fits under, or undefined for a
 *  reading no clock can produce (negative, NaN, infinite). */
export const keyActionDurationBucket = (
  durationMs: number,
): KeyActionDurationBucketMs | undefined => {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return undefined;
  }
  return (
    KEY_ACTION_DURATION_BUCKETS_MS.find((bound) => durationMs <= bound) ??
    KEY_ACTION_DURATION_OVERFLOW_MS
  );
};

export type KeyActionTimer = {
  /** Reports the time since the timer started; later calls do nothing, so
   *  a settle path that runs twice still reports one duration. */
  finish: () => void;
  /** Fixes the end of the action without reporting it yet: the action is
   *  over, but whether it counts is decided later. The first mark wins. */
  mark: () => void;
  /** Drops the measurement: the action failed or was abandoned, and its
   *  duration would skew the success timings. */
  cancel: () => void;
};

type KeyActionTimerOptions = {
  /** A finish later than this reports nothing: the end signal no longer
   *  belongs to the start (a tab reopened long after its first click). */
  abandonAfterMs?: number | undefined;
  now?: (() => number) | undefined;
};

export const startKeyActionTimer = (
  analytics: Pick<Analytics, "captureKeyActionTiming">,
  measure: KeyActionMeasure,
  { abandonAfterMs, now = () => performance.now() }: KeyActionTimerOptions = {},
): KeyActionTimer => {
  const startedAt = now();
  let endedAt: number | undefined;
  let settled = false;
  return {
    finish: () => {
      if (settled) {
        return;
      }
      settled = true;
      const elapsedMs = (endedAt ?? now()) - startedAt;
      if (abandonAfterMs !== undefined && elapsedMs > abandonAfterMs) {
        return;
      }
      const durationBucketMs = keyActionDurationBucket(elapsedMs);
      if (durationBucketMs === undefined) {
        return;
      }
      analytics.captureKeyActionTiming({ ...measure, durationBucketMs });
    },
    mark: () => {
      endedAt ??= now();
    },
    cancel: () => {
      settled = true;
    },
  };
};
