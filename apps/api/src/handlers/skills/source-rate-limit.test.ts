import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { API_RATE_LIMITS } from "@/api/lib/limits";
import type { recordBudgetRejection } from "@/api/lib/rate-limit/budget-observability";
import { RedisRateLimitContext } from "@/api/lib/rate-limit/redis-context";

import {
  consumeSkillSourceRateLimit,
  createSkillSourceRateLimitGenerator,
  isSkillSourceRateLimitedRequest,
  skillSourceRateLimitBinding,
} from "./source-rate-limit";

const request = (method: string, path: string) => ({
  method,
  url: `https://stella.example${path}`,
});

describe("skill source rate-limit routing", () => {
  test("matches outbound skill discovery and import requests", () => {
    expect(
      isSkillSourceRateLimitedRequest(
        request("POST", "/v1/skills/discover-url"),
      ),
    ).toBe(true);
    expect(
      isSkillSourceRateLimitedRequest(request("POST", "/v1/skills/import-url")),
    ).toBe(true);
    expect(
      isSkillSourceRateLimitedRequest(
        request("POST", "/v1/skills/import-urls/"),
      ),
    ).toBe(true);
  });

  test("leaves other skill requests outside the source-fetch budget", () => {
    expect(isSkillSourceRateLimitedRequest(request("POST", "/v1/skills"))).toBe(
      false,
    );
    expect(
      isSkillSourceRateLimitedRequest(
        request("GET", "/v1/skills/discover-url"),
      ),
    ).toBe(false);
  });

  test("shares one fixed-window budget by client IP", async () => {
    const context = new RedisRateLimitContext({
      createRedis: () => ({
        send: async () => {
          throw new Error("redis disabled in test");
        },
      }),
      failurePolicy: "fail_open_local",
      onRedisError: () => undefined,
    });
    try {
      for (let index = 0; index < 10; index += 1) {
        const result = await consumeSkillSourceRateLimit({
          clientIp: "192.0.2.1",
          context,
          requestId: `request-${index}`,
        });
        expect(result.ok).toBe(true);
      }
      expect(
        (
          await consumeSkillSourceRateLimit({
            clientIp: "192.0.2.1",
            context,
            requestId: "overflow",
          })
        ).ok,
      ).toBe(false);
      expect(
        (
          await consumeSkillSourceRateLimit({
            clientIp: "192.0.2.2",
            context,
            requestId: "other-ip",
          })
        ).ok,
      ).toBe(true);
    } finally {
      context.kill();
    }
  });
});

test("verified skill-source callers share REST and MCP quotas across addresses", async () => {
  const context = new RedisRateLimitContext({
    createRedis: () => ({
      send: async () => {
        throw new Error("redis disabled in test");
      },
    }),
    failurePolicy: "fail_open_local",
    onRedisError: () => undefined,
  });
  const userId = toSafeId<"user">("user-a");
  const generator = createSkillSourceRateLimitGenerator(async () => userId);
  const req = new Request("https://stella.example/v1/skills/discover-url");
  const restKey = await generator(req, {
    requestIP: () => ({ address: "192.0.2.1" }),
  });
  expect(restKey).toBe("skill-source:user:user-a");
  expect(
    await generator(req, { requestIP: () => ({ address: "192.0.2.2" }) }),
  ).toBe(restKey);
  try {
    for (let index = 0; index < API_RATE_LIMITS.skillSource.max; index += 1) {
      expect(
        (
          await consumeSkillSourceRateLimit({
            clientIp: "192.0.2.1",
            context,
            userId,
          })
        ).ok,
      ).toBe(true);
    }
    expect(
      (
        await consumeSkillSourceRateLimit({
          clientIp: "192.0.2.2",
          context,
          userId,
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await consumeSkillSourceRateLimit({
          clientIp: "192.0.2.1",
          context,
          userId: toSafeId<"user">("user-b"),
        })
      ).ok,
    ).toBe(true);
  } finally {
    context.kill();
  }
});

test("unverified REST source callers retain the address fallback", async () => {
  const generator = createSkillSourceRateLimitGenerator(async () => null);
  expect(
    await generator(
      new Request("https://stella.example/v1/skills/import-url"),
      { requestIP: () => ({ address: "192.0.2.1" }) },
    ),
  ).toBe("skill-source:192.0.2.1");
});

test.each(["user", "address"] as const)(
  "source %s refusals emit one shared budget observation",
  async (keyKind) => {
    const observations: Parameters<typeof recordBudgetRejection>[0][] = [];
    let count = 1;
    const input = {
      clientIp: "192.0.2.10",
      ...(keyKind === "user"
        ? { userId: toSafeId<"user">("source-user") }
        : {}),
      context: {
        increment: async () => ({
          count,
          start: 0,
          nextReset: new Date(API_RATE_LIMITS.skillSource.duration),
        }),
        complete: async () => undefined,
      },
      recordRejection: (
        observation: Parameters<typeof recordBudgetRejection>[0],
      ) => observations.push(observation),
    };
    expect((await consumeSkillSourceRateLimit(input)).ok).toBe(true);
    expect(observations).toEqual([]);
    count = API_RATE_LIMITS.skillSource.max + 1;
    expect((await consumeSkillSourceRateLimit(input)).ok).toBe(false);
    const expected = {
      name: keyKind === "user" ? "skills.source.user" : "skills.source.address",
      keyKind,
      windowMs: API_RATE_LIMITS.skillSource.duration,
    };
    expect(observations).toEqual([expected]);
    const generator = createSkillSourceRateLimitGenerator(async () =>
      keyKind === "user" ? toSafeId<"user">("source-user") : null,
    );
    const key = await generator(
      new Request("https://api.example/v1/skills/discover-url"),
      { requestIP: () => ({ address: "192.0.2.10" }) },
    );
    expect(skillSourceRateLimitBinding.budget(key)).toEqual({
      name: expected.name,
      keyKind,
    });
  },
);
