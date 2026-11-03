import { expect, test } from "bun:test";

import { LIMITER_STORE_UNAVAILABLE } from "@stll/api-contract/action-admission";

import { toSafeId } from "@/api/lib/branded-types";
import { RedisRateLimitContext } from "@/api/lib/rate-limit/redis-context";

import { consumeDictationLimit } from "./limits";

const userId = toSafeId<"user">("user_fixture");
const organizationId = toSafeId<"organization">("org_fixture");

test("limits each user independently and shares the organization budget", async () => {
  const context = new RedisRateLimitContext({
    createRedis: () => ({
      send: async () => {
        throw new TypeError("Fixture store unavailable");
      },
    }),
    failurePolicy: "fail_open_local",
    onRedisError: () => undefined,
  });
  context.init({ duration: 60_000 });
  for (let index = 0; index < 30; index++) {
    expect(
      (await consumeDictationLimit({ userId, organizationId, context })).isOk(),
    ).toBe(true);
  }
  const userRefused = await consumeDictationLimit({
    userId,
    organizationId,
    context,
  });
  expect(userRefused.isErr()).toBe(true);
  for (let index = 0; index < 89; index++) {
    expect(
      (
        await consumeDictationLimit({
          userId: toSafeId<"user">(`user_${index}`),
          organizationId,
          context,
        })
      ).isOk(),
    ).toBe(true);
  }
  expect(
    (
      await consumeDictationLimit({
        userId: toSafeId<"user">("user_fresh"),
        organizationId,
        context,
      })
    ).isErr(),
  ).toBe(true);
  expect(
    (
      await consumeDictationLimit({
        userId: toSafeId<"user">("user_fresh"),
        organizationId: toSafeId<"organization">("org_other"),
        context,
      })
    ).isOk(),
  ).toBe(true);
  context.kill();
});

test("unavailable counters fail closed without echoing their error", async () => {
  const result = await consumeDictationLimit({
    userId,
    organizationId,
    context: {
      increment: async () => {
        throw new TypeError("fixture private payload");
      },
      complete: () => undefined,
      decrement: () => undefined,
    },
  });
  expect(result.isErr()).toBe(true);
  if (result.isOk()) {
    throw new TypeError("Expected limiter refusal");
  }
  expect(result.error).toMatchObject(LIMITER_STORE_UNAVAILABLE);
  expect(JSON.stringify(result)).not.toContain("fixture private payload");
});

for (const failedBudget of ["user", "organization"] as const) {
  for (const completionOrder of ["failure-first", "failure-last"] as const) {
    test(`store failure refunds both attempts: ${failedBudget}, ${completionOrder}`, async () => {
      const firstAttempt = Promise.withResolvers<undefined>();
      const counts = new Map<string, number>();
      const pending = new Set<string>();
      const refunded = new Set<string>();
      const completed = new Set<string>();
      const result = await consumeDictationLimit({
        userId,
        organizationId,
        context: {
          increment: async (key) => {
            const fails = key.includes(`dictation:${failedBudget}:`);
            if (fails === (completionOrder === "failure-last")) {
              await firstAttempt.promise;
            } else {
              firstAttempt.resolve(undefined);
            }
            // A failed reply can still have charged its request at the store.
            counts.set(key, 1);
            pending.add(key);
            if (fails) {
              throw new TypeError("fixture private payload");
            }
            return { count: 1, start: 0, nextReset: new Date(60_000) };
          },
          decrement: (key) => {
            if (pending.delete(key)) {
              counts.set(key, 0);
              refunded.add(key);
            }
          },
          complete: (key) => {
            pending.delete(key);
            completed.add(key);
          },
        },
      });
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toMatchObject(LIMITER_STORE_UNAVAILABLE);
      }
      expect(JSON.stringify(result)).not.toContain("fixture private payload");
      expect(counts.size).toBe(2);
      expect([...counts.values()]).toEqual([0, 0]);
      expect(refunded.size).toBe(2);
      expect(completed.size).toBe(0);
      expect(pending.size).toBe(0);
    });
  }
}
