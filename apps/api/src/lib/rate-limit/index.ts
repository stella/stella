import type { Context, Generator, Options } from "elysia-rate-limit";

type RateLimitEntry = {
  count: number;
  start: number;
  expiresAt: number;
};

const CLEANUP_INTERVAL_MS = 60_000;

/**
 * Key generator that prefixes the client IP with a scope
 * name, so separate rateLimit instances get independent
 * counters.
 */
export const scopedGenerator =
  (scope: string): Generator =>
  (request, server) => {
    const address = server?.requestIP(request)?.address;
    if (!address) {
      return scope;
    }
    return `${scope}:${address}`;
  };

/**
 * In-memory rate limiting. Each process maintains its own
 * counters; with multiple instances, a client may get up
 * to N× the configured limit. The hard global limit is
 * enforced at the network edge.
 */
export class InMemoryRateLimitContext implements Context {
  private durationMs = 60_000;
  private store = new Map<string, RateLimitEntry>();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor() {
    this.cleanupTimer = setInterval(
      () => this.evictExpired(),
      CLEANUP_INTERVAL_MS,
    );
    this.cleanupTimer.unref();
  }

  init(options: Omit<Options, "context">) {
    if (typeof options.duration === "number") {
      this.durationMs = options.duration;
    }
  }

  increment(key: string, duration?: number, requestTime?: number) {
    const effectiveDuration = duration ?? this.durationMs;
    const now = requestTime ?? Date.now();
    const entry = this.store.get(key);

    if (entry && entry.expiresAt > now) {
      entry.count += 1;
      return {
        count: entry.count,
        nextReset: new Date(entry.expiresAt),
        start: entry.start,
      };
    }

    const expiresAt = now + effectiveDuration;
    this.store.set(key, { count: 1, start: now, expiresAt });
    return {
      count: 1,
      nextReset: new Date(expiresAt),
      start: now,
    };
  }

  decrement(key: string) {
    const now = Date.now();
    const entry = this.store.get(key);
    if (entry && entry.expiresAt > now && entry.count > 0) {
      entry.count -= 1;
    }
  }

  reset(key?: string) {
    if (key) {
      this.store.delete(key);
    } else {
      this.store.clear();
    }
  }

  kill() {
    clearInterval(this.cleanupTimer);
    this.store.clear();
  }

  private evictExpired() {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (entry.expiresAt <= now) {
        this.store.delete(key);
      }
    }
  }
}
