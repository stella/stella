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
    },
  });
  expect(result.isErr()).toBe(true);
  if (result.isOk()) {
    throw new TypeError("Expected limiter refusal");
  }
  expect(result.error).toMatchObject(LIMITER_STORE_UNAVAILABLE);
  expect(JSON.stringify(result)).not.toContain("fixture private payload");
});
