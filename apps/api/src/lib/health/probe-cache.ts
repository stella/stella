/**
 * Coalesces calls to a slow probe behind a short-lived cache and an
 * in-flight de-duplication wrapper. Used by `/health` so that a flood
 * of concurrent requests turns into at most one underlying probe per
 * cache window, rather than one probe per request. Both successful
 * and failed outcomes are cached for the same TTL so an outage stays
 * visible to monitoring without thundering against the dependency.
 *
 * TTL accounting uses a monotonic time source so an NTP correction or
 * VM/container resume that moves wall-clock time backward cannot
 * extend a cached outcome past its intended window.
 */

export type ProbeOutcome<TError> = { ok: true } | { ok: false; error: TError };

export type ProbeCacheOptions = {
  /** Maximum age of a cached outcome before a fresh probe is run. */
  ttlMs: number;
  /**
   * Monotonic millisecond source. Defaults to `performance.now()`.
   * Injectable for tests; supplied implementations must be monotonic
   * non-decreasing — the cache trusts them without re-checking.
   */
  now?: () => number;
};

export type ProbeCache<TError> = {
  /**
   * Run the probe through the cache. The first caller in a window
   * triggers the probe; concurrent callers share its in-flight
   * promise; later callers within the TTL get the cached outcome.
   */
  run: () => Promise<ProbeOutcome<TError>>;
};

export const createProbeCache = <TError>(
  probe: () => Promise<ProbeOutcome<TError>>,
  options: ProbeCacheOptions,
): ProbeCache<TError> => {
  const ttlMs = options.ttlMs;
  const now = options.now ?? (() => performance.now());

  let cached: { monotonicAt: number; outcome: ProbeOutcome<TError> } | null =
    null;
  let inflight: Promise<ProbeOutcome<TError>> | null = null;

  const run = async (): Promise<ProbeOutcome<TError>> => {
    const t = now();
    if (cached !== null && t - cached.monotonicAt < ttlMs) {
      return cached.outcome;
    }
    if (inflight !== null) {
      return await inflight;
    }
    inflight = (async () => {
      try {
        const outcome = await probe();
        cached = { monotonicAt: now(), outcome };
        return outcome;
      } finally {
        inflight = null;
      }
    })();
    return await inflight;
  };

  return { run };
};
