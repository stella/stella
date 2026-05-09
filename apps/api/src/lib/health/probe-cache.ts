/**
 * Coalesces calls to a slow probe behind a short-lived cache and an
 * in-flight de-duplication wrapper. Used by `/health` so that a flood
 * of concurrent requests turns into at most one underlying probe per
 * cache window, rather than one probe per request.
 */

export type ProbeOutcome<TError> = { ok: true } | { ok: false; error: TError };

type Cached<TError> = {
  at: number;
  outcome: ProbeOutcome<TError>;
};

export type ProbeCacheOptions = {
  /** Maximum age of a cached outcome before a fresh probe is run. */
  ttlMs: number;
  /** Wall-clock source. Defaults to `Date.now`; injectable for tests. */
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
  const now = options.now ?? Date.now;

  let cached: Cached<TError> | null = null;
  let inflight: Promise<ProbeOutcome<TError>> | null = null;

  const run = async (): Promise<ProbeOutcome<TError>> => {
    const t = now();
    if (cached !== null && t - cached.at < ttlMs) {
      return cached.outcome;
    }
    if (inflight !== null) {
      return await inflight;
    }
    inflight = (async () => {
      try {
        const outcome = await probe();
        cached = { at: now(), outcome };
        return outcome;
      } finally {
        inflight = null;
      }
    })();
    return await inflight;
  };

  return { run };
};
