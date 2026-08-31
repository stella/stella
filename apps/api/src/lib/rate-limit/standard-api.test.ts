import { describe, expect, test } from "bun:test";

import { API_RATE_LIMITS } from "@/api/lib/limits";
import { RedisRateLimitContext } from "@/api/lib/rate-limit/redis-context";

import { createStandardApiRateLimitOptions } from "./standard-api";

describe("standard API rate limiting", () => {
  test("uses the shared Redis-backed API budget", async () => {
    const options = createStandardApiRateLimitOptions();
    const request = Object.assign(
      new Request("https://stella.example/v1/memories"),
      { cookie: {} },
    );

    try {
      const key = await options.generator(request, null);

      expect(options.context).toBeInstanceOf(RedisRateLimitContext);
      expect(key.startsWith("api")).toBe(true);
      expect(options.duration).toBe(API_RATE_LIMITS.api.duration);
      expect(options.max).toBe(API_RATE_LIMITS.api.max);
    } finally {
      await options.context.kill();
    }
  });
});
