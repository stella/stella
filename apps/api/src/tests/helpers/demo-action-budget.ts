import type { SafeId } from "@/api/lib/branded-types";
import type { DemoActionBudget } from "@/api/lib/rate-limit/demo-action-budget";
import { createRedisRateLimitRequestKey } from "@/api/lib/rate-limit/redis-context";

const REQUEST_KEY_SEPARATOR = createRedisRateLimitRequestKey({
  counterKey: "",
  requestId: "",
});

// Fixed windows keyed like the shared store: one counter per counter key,
// expiring at the requested time, with refunds addressed by request key.
const windowCounter = () => {
  const windows = new Map<string, { count: number; expiresAt: number }>();
  const counterKeyOf = (key: string) =>
    key.slice(0, key.lastIndexOf(REQUEST_KEY_SEPARATOR));
  return {
    count: () =>
      Array.from(windows.values()).reduce(
        (total, window) => total + window.count,
        0,
      ),
    increment: (key: string, duration = 0, requestTime = 0) => {
      const counterKey = counterKeyOf(key);
      const current = windows.get(counterKey);
      const window =
        current !== undefined && current.expiresAt > requestTime
          ? { count: current.count + 1, expiresAt: current.expiresAt }
          : { count: 1, expiresAt: requestTime + duration };
      windows.set(counterKey, window);
      return {
        count: window.count,
        nextReset: new Date(window.expiresAt),
        start: requestTime,
      };
    },
    decrement: (key: string) => {
      const window = windows.get(counterKeyOf(key));
      if (window !== undefined && window.count > 0) {
        window.count -= 1;
      }
    },
    complete: (_key: string) => undefined,
  };
};

type TestDemoActionBudgetOptions = {
  demoUserId: SafeId<"user">;
  nowMs: number;
};

/** An in-memory demo budget whose counter and clock a test controls. */
export const createTestDemoActionBudget = ({
  demoUserId,
  nowMs,
}: TestDemoActionBudgetOptions) => {
  const counter = windowCounter();
  let now = nowMs;
  let increments = 0;
  const completedKeys: string[] = [];
  const budget: DemoActionBudget = {
    resolveDemoUserId: async () => await Promise.resolve(demoUserId),
    counter: () => ({
      increment: async (key, duration, requestTime) => {
        increments += 1;
        // Yield like the shared store, so concurrent attempts interleave.
        await Promise.resolve();
        return counter.increment(key, duration, requestTime);
      },
      decrement: async (key) => {
        await Promise.resolve();
        counter.decrement(key);
      },
      complete: async (key) => {
        await Promise.resolve();
        counter.complete(key);
        completedKeys.push(key);
      },
    }),
    now: () => now,
  };
  return {
    budget,
    setNow: (time: number) => {
      now = time;
    },
    increments: () => increments,
    completions: () => completedKeys.length,
    /** The live count summed over every daily window. */
    count: counter.count,
  };
};
