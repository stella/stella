type RootPoolSnapshot =
  | { status: "observed"; size: number; inUse: number; idle: number }
  | { status: "unavailable"; size: null; inUse: null; idle: null };

const SAMPLE_EVERY = 64;
const MAX_BUCKET_MS = 60_000;

type RootPoolWindowOptions = {
  now?: () => number;
  random?: () => number;
};

// Millisecond upper bounds, with one overflow bucket. Storage is allocated
// once; acquisition paths return only a primitive timer token.
export const createRootPoolWindow = ({
  now = () => performance.now(),
  random = Math.random,
}: RootPoolWindowOptions = {}) => {
  const buckets = new Float64Array(MAX_BUCKET_MS + 1);
  let requestInBlock = 0;
  let sampleAt = 0;
  let samples = 0;
  let maxMs = 0;
  let waiting = 0;
  let waitingPeak = 0;
  let inUse = 0;
  let inUsePeak = 0;
  let failed = 0;
  let windowStart = now();

  const percentile = (fraction: number) => {
    if (samples === 0) {
      return null;
    }
    const rank = Math.ceil(samples * fraction);
    let count = 0;
    for (let bound = 0; bound < buckets.length; bound += 1) {
      count += buckets[bound] ?? 0;
      if (count < rank) {
        continue;
      }
      return bound === MAX_BUCKET_MS ? maxMs : Math.min(bound, maxMs);
    }
    return maxMs;
  };

  return {
    requested: () => {
      waiting += 1;
      waitingPeak = Math.max(waitingPeak, waiting);
      // A fresh uniform position per block prevents periodic batches from
      // always selecting the same acquisition; one draw costs no allocation.
      if (requestInBlock === 0) {
        sampleAt = Math.floor(random() * SAMPLE_EVERY);
      }
      const sampled = requestInBlock === sampleAt;
      requestInBlock = (requestInBlock + 1) % SAMPLE_EVERY;
      return sampled ? now() : null;
    },
    acquired: (started: number | null) => {
      waiting -= 1;
      inUse += 1;
      inUsePeak = Math.max(inUsePeak, inUse);
      if (started === null) {
        return;
      }
      const elapsed = Math.max(0, now() - started);
      const bucket = Math.min(MAX_BUCKET_MS, Math.ceil(elapsed));
      buckets[bucket] = (buckets[bucket] ?? 0) + 1;
      samples += 1;
      maxMs = Math.max(maxMs, elapsed);
    },
    failed: () => {
      waiting -= 1;
      failed += 1;
    },
    released: () => {
      inUse -= 1;
    },
    flush: (max: number, snapshot: RootPoolSnapshot) => {
      const end = now();
      const record = {
        max,
        size: snapshot.size,
        inUse: snapshot.inUse,
        idle: snapshot.idle,
        snapshotStatus: snapshot.status,
        acquisitionScope: "transactions" as const,
        inUseTransactions: inUse,
        waitingRequests: waiting,
        waitingRequestsPeak: waitingPeak,
        inUseTransactionsPeak: inUsePeak,
        waitP50Ms: percentile(0.5),
        waitP95Ms: percentile(0.95),
        waitMaxMs: samples === 0 ? null : maxMs,
        waitSamples: samples,
        acquisitionFailures: failed,
        intervalMs: end - windowStart,
        sampleEvery: SAMPLE_EVERY,
      };
      buckets.fill(0);
      waitingPeak = waiting;
      inUsePeak = inUse;
      samples = 0;
      maxMs = 0;
      failed = 0;
      windowStart = end;
      return record;
    },
  };
};

export type RootPoolWindow = ReturnType<typeof createRootPoolWindow>;
export type RootPoolReport = ReturnType<RootPoolWindow["flush"]>;
