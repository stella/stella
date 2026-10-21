import { describe, expect, test } from "bun:test";

import { createRedisClient } from "@/api/lib/redis-client";

import { SYNTHETIC_SESSION_MINT_BUDGETS } from "./budget-config";
import { RedisRateLimitContext } from "./redis-context";
import { createSyntheticSessionBudget } from "./synthetic-session-budget";

const enabled = process.env["STELLA_RUN_VALKEY_TESTS"] === "true";

describe.skipIf(!enabled)("monitoring mint counters", () => {
  test("the counter service enforces both configured mint windows", async () => {
    const client = createRedisClient({ storeClass: "durable-coordination" });
    try {
      await client.connect();
      const context = new RedisRateLimitContext({
        failurePolicy: "fail_closed",
        createRedis: () => ({
          send: async (command, args) => client.send(command, args),
        }),
      });
      const prefix = Bun.randomUUIDv7();
      const keys = new Set<string>();
      const reserve = createSyntheticSessionBudget({
        context: {
          increment: async (key, duration) => {
            const scopedKey = `${prefix}:${key}`;
            keys.add(scopedKey);
            return context.increment(scopedKey, duration);
          },
        },
      });
      try {
        for (
          let count = 0;
          count < SYNTHETIC_SESSION_MINT_BUDGETS.hour.max;
          count++
        ) {
          expect(await reserve()).toBe(true);
        }
        expect(await reserve()).toBe(false);
        await context.reset(`${prefix}:synthetic-session:hour`);
        for (
          let count = 0;
          count <
          SYNTHETIC_SESSION_MINT_BUDGETS.day.max -
            SYNTHETIC_SESSION_MINT_BUDGETS.hour.max;
          count++
        ) {
          await context.increment(
            `${prefix}:synthetic-session:day`,
            SYNTHETIC_SESSION_MINT_BUDGETS.day.durationMs,
          );
        }
        expect(await reserve()).toBe(false);
      } finally {
        for (const key of keys) {
          await context.reset(key);
        }
        context.kill();
      }
    } finally {
      client.close();
    }
  });
});
