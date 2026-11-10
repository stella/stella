/**
 * Process-local single-flight and short-TTL cache for public corpus searches.
 *
 * A burst of agents repeating a search, or one agent firing the same phrasing
 * from several calls, should cost the engine one read. Identical searches in
 * flight together share that read; a search repeated moments later is answered
 * from what the last one found.
 *
 * Safe to share because the corpus is public: the key is the normalized
 * request and the serving generation, and nothing about the caller reaches a
 * search answer (see `caseLawSearchCoalescingKey`). A caller's own limits are
 * in the key as the values they resolve to, not as the caller's identity.
 *
 * The cache holds complete answers only: an answer shaped by load (a search
 * stopped on its time budget, for instance) is shared with the callers already
 * waiting on it but never kept for the next one. Nothing here is required for
 * correctness: a cold process, an eviction or a failed flight only means the
 * engine is asked again.
 */

import { requestAbortedRefusal } from "@/api/lib/legal-search/search-index-unavailable";

type PublicSearchCoalescerLimits = {
  maxEntries: number;
  /** Approximate retained bytes: the UTF-16 size of each stored answer's JSON. */
  maxBytes: number;
  ttlMs: number;
};

type StoredAnswer<T> = {
  answer: T;
  bytes: number;
  expiresAt: number;
};

type Flight<T> = {
  settled: Promise<{ answer: T; shareable: boolean }>;
  controller: AbortController;
  /** Callers still waiting; the engine read is dropped only when none are. */
  waiters: number;
};

const BYTES_PER_CODE_UNIT = 2;

type PublicSearchCoalescerOptions = {
  limits: PublicSearchCoalescerLimits;
  /** Epoch milliseconds; injected so expiry is testable without waiting. */
  now: () => number;
};

type CoalescedSearchOptions<T> = {
  key: string;
  /**
   * The caller's cancellation: only it leaves the flight, others stay. A
   * caller that leaves is refused as a request abort, its reason the cause.
   */
  signal?: AbortSignal | undefined;
  /** Whether this answer may be kept: complete, not shaped by load. */
  cacheable: (answer: T) => boolean;
  /** The engine read; aborted once every caller waiting on it has left. */
  run: (signal: AbortSignal) => Promise<T>;
};

export const createPublicSearchCoalescer = <T>({
  limits,
  now,
}: PublicSearchCoalescerOptions) => {
  // Map order is recency order: a hit re-inserts, eviction takes the first.
  const entries = new Map<string, StoredAnswer<T>>();
  const flights = new Map<string, Flight<T>>();
  let storedBytes = 0;

  const forget = (key: string): void => {
    const entry = entries.get(key);
    if (entry === undefined) {
      return;
    }
    entries.delete(key);
    storedBytes -= entry.bytes;
  };

  const lookup = (key: string): T | undefined => {
    const entry = entries.get(key);
    if (entry === undefined) {
      return undefined;
    }
    if (entry.expiresAt <= now()) {
      forget(key);
      return undefined;
    }
    entries.delete(key);
    entries.set(key, entry);
    return entry.answer;
  };

  const store = (key: string, answer: T): void => {
    const bytes =
      (key.length + JSON.stringify(answer).length) * BYTES_PER_CODE_UNIT;
    forget(key);
    if (bytes > limits.maxBytes) {
      return;
    }
    entries.set(key, { answer, bytes, expiresAt: now() + limits.ttlMs });
    storedBytes += bytes;
    while (entries.size > limits.maxEntries || storedBytes > limits.maxBytes) {
      const oldest = entries.keys().next();
      if (oldest.done) {
        return;
      }
      forget(oldest.value);
    }
  };

  const startFlight = (
    key: string,
    { cacheable, run }: Pick<CoalescedSearchOptions<T>, "cacheable" | "run">,
  ): Flight<T> => {
    const controller = new AbortController();
    const flight: Flight<T> = {
      controller,
      waiters: 0,
      settled: run(controller.signal)
        .then((answer) => {
          const shareable = cacheable(answer);
          if (shareable) {
            store(key, answer);
          }
          return { answer, shareable };
        })
        .finally(() => {
          flights.delete(key);
        }),
    };
    flights.set(key, flight);
    return flight;
  };

  const leave = (flight: Flight<T>, reason: unknown): void => {
    flight.waiters -= 1;
    if (flight.waiters === 0) {
      flight.controller.abort(reason);
    }
  };

  /**
   * Wait for the flight, or leave it when the caller cancels. Leaving never
   * cancels the read while another caller still waits on it.
   */
  const waitOnFlight = async (
    flight: Flight<T>,
    signal: AbortSignal | undefined,
  ): Promise<{ answer: T; shareable: boolean }> => {
    flight.waiters += 1;
    if (signal === undefined) {
      return await flight.settled.finally(() => {
        flight.waiters -= 1;
      });
    }
    const left = Promise.withResolvers<never>();
    const onAbort = () => {
      leave(flight, signal.reason);
      left.reject(requestAbortedRefusal(signal.reason));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    return await Promise.race([flight.settled, left.promise]).finally(() => {
      signal.removeEventListener("abort", onAbort);
      // A caller that left was counted out when it left.
      if (!signal.aborted) {
        flight.waiters -= 1;
      }
    });
  };

  const search = async ({
    key,
    signal,
    cacheable,
    run,
  }: CoalescedSearchOptions<T>): Promise<T> => {
    if (signal?.aborted === true) {
      throw requestAbortedRefusal(signal.reason);
    }
    const stored = lookup(key);
    if (stored !== undefined) {
      return structuredClone(stored);
    }
    const flight = flights.get(key) ?? startFlight(key, { cacheable, run });
    const { answer, shareable } = await waitOnFlight(flight, signal);
    // A kept answer stays private to the cache: no caller may mutate what
    // the next one is served. Anything else is one answer to one flight.
    return shareable ? structuredClone(answer) : answer;
  };

  return { search };
};
