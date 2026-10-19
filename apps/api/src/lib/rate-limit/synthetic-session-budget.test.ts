import { expect, test } from "bun:test";

import { SYNTHETIC_SESSION_MINT_BUDGETS } from "@/api/lib/rate-limit/budget-config";
import { RedisRateLimitContext } from "@/api/lib/rate-limit/redis-context";

import { createSyntheticSessionBudget } from "./synthetic-session-budget";

test.each(Object.entries(SYNTHETIC_SESSION_MINT_BUDGETS))(
  "%s session budget enforces its configured window",
  async (window, budget) => {
    const counts = new Map<string, number>();
    const reserve = createSyntheticSessionBudget({
      context: {
        increment: (key, durationMs) => {
          const count = key.endsWith(window) ? (counts.get(key) ?? 0) + 1 : 1;
          counts.set(key, count);
          return { count, start: 0, nextReset: new Date(durationMs ?? 0) };
        },
      },
    });
    for (let index = 0; index < budget.max; index++) {
      expect(await reserve()).toBe(true);
    }
    expect(await reserve()).toBe(false);
  },
);

test("session minting is unavailable when the counter service is unavailable", async () => {
  const context = new RedisRateLimitContext({
    failurePolicy: "fail_closed",
    createRedis: () => ({
      send: async () => {
        throw new TypeError("Counter service unavailable");
      },
    }),
    onRedisError: () => undefined,
  });
  try {
    const reserve = createSyntheticSessionBudget({ context });
    expect(await reserve()).toBe(false);
  } finally {
    context.kill();
  }
});
