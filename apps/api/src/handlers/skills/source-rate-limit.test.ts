import { describe, expect, test } from "bun:test";

import { RedisRateLimitContext } from "@/api/lib/rate-limit/redis-context";

import {
  consumeSkillSourceRateLimit,
  isSkillSourceRateLimitedRequest,
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
