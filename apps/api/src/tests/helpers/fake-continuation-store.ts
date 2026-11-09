import { Result } from "better-result";

import type { ContinuationStore } from "@/api/lib/legal-search/public-read-continuation";

/** One coordination store two API tasks share, on a clock the test moves. */
export const createFakeContinuationStore = () => {
  const values = new Map<string, { value: string; expiresAt: number }>();
  let available = true;
  let clock = 0;
  const live = (key: string) => {
    const entry = values.get(key);
    if (entry === undefined) {
      return null;
    }
    if (entry.expiresAt <= clock) {
      values.delete(key);
      return null;
    }
    return entry.value;
  };
  const put = (key: string, value: string, ttlMs: number) => {
    values.set(key, { value, expiresAt: clock + ttlMs });
  };
  const guarded = async <T>(run: () => T) =>
    await Promise.resolve(
      available
        ? Result.ok(run())
        : Result.err({ type: "unavailable" as const, cause: "down" }),
    );
  const store: ContinuationStore = {
    readSpec: async (id) => await guarded(() => live(`spec:${id}`)),
    writeSpec: async (id, spec, ttl) =>
      await guarded(() => {
        put(`spec:${id}`, spec, ttl);
      }),
    readFinished: async (id) => await guarded(() => live(`done:${id}`)),
    writeFinished: async (id, done, ttl) =>
      await guarded(() => {
        put(`done:${id}`, done, ttl);
      }),
    readProgress: async (id) => await guarded(() => live(`prog:${id}`)),
    writeProgress: async (id, progress, ttl) =>
      await guarded(() => {
        put(`prog:${id}`, progress, ttl);
      }),
    acquireLease: async (id, owner, ttl) =>
      await guarded(() => {
        if (live(`lease:${id}`) !== null) {
          return false;
        }
        put(`lease:${id}`, owner, ttl);
        return true;
      }),
    renewLease: async (id, owner, ttl) =>
      await guarded(() => {
        if (live(`lease:${id}`) !== owner) {
          return false;
        }
        put(`lease:${id}`, owner, ttl);
        return true;
      }),
    releaseLease: async (id, owner) =>
      await guarded(() => {
        if (live(`lease:${id}`) === owner) {
          values.delete(`lease:${id}`);
        }
      }),
    countAttempt: async (id, ttl) =>
      await guarded(() => {
        const next = Number(live(`attempts:${id}`) ?? 0) + 1;
        put(`attempts:${id}`, String(next), ttl);
        return next;
      }),
    clearAttempts: async (id) =>
      await guarded(() => {
        values.delete(`attempts:${id}`);
      }),
  };
  return {
    store,
    now: () => clock,
    /** Time passing: leases and answers expire only through this. */
    advance: (ms: number) => {
      clock += ms;
    },
    /** Whether an answer has been stored for this work. */
    hasFinished: (workId: string) => live(`done:${workId}`) !== null,
    setAvailable: (value: boolean) => {
      available = value;
    },
  };
};
