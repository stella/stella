import { describe, expect, mock, test } from "bun:test";

import { LIMITS } from "@/api/lib/limits";
import { createMcpGatewayRateLimiter } from "@/api/mcp/gateway/rate-limit";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

type RedisEntry = {
  count: number;
  expiresAt: number;
};

const createRedisFake = (now: () => number) => {
  const store = new Map<string, RedisEntry>();
  const send = mock(
    async (
      command: string,
      args: [string, "1", string, string],
    ): Promise<number> => {
      expect(command).toBe("EVAL");
      const [_script, keyCount, key, windowMsRaw] = args;
      expect(keyCount).toBe("1");

      const windowMs = Number(windowMsRaw);
      const current = store.get(key);
      if (!current || current.expiresAt <= now()) {
        store.set(key, { count: 1, expiresAt: now() + windowMs });
        return 1;
      }

      current.count += 1;
      return current.count;
    },
  );

  return { send, store };
};

describe("MCP gateway rate limiter", () => {
  test("uses one Redis script per consume and rejects over-budget calls", async () => {
    let currentTime = 1000;
    const redis = createRedisFake(() => currentTime);
    const limiter = createMcpGatewayRateLimiter({
      createRedis: () => asTestRaw(redis),
      now: () => currentTime,
      onRedisError: () => undefined,
    });

    for (let index = 0; index < LIMITS.mcpGatewayRateLimitMax; index += 1) {
      expect(
        await limiter.consume({ connectorSlug: "registry", userId: "user_1" }),
      ).toBe(true);
    }

    expect(
      await limiter.consume({ connectorSlug: "registry", userId: "user_1" }),
    ).toBe(false);
    expect(redis.send).toHaveBeenCalledTimes(LIMITS.mcpGatewayRateLimitMax + 1);

    currentTime += LIMITS.mcpGatewayRateLimitWindowMs;
    expect(
      await limiter.consume({ connectorSlug: "registry", userId: "user_1" }),
    ).toBe(true);
  });

  test("falls back to a per-process window when Redis is unavailable", async () => {
    let currentTime = 1000;
    const onRedisError = mock();
    const limiter = createMcpGatewayRateLimiter({
      createRedis: () =>
        asTestRaw({
          send: mock(async () => {
            throw new Error("redis unavailable");
          }),
        }),
      now: () => currentTime,
      onRedisError: (error) => {
        onRedisError(error);
      },
    });

    for (let index = 0; index < LIMITS.mcpGatewayRateLimitMax; index += 1) {
      expect(
        await limiter.consume({ connectorSlug: "registry", userId: "user_1" }),
      ).toBe(true);
    }

    expect(
      await limiter.consume({ connectorSlug: "registry", userId: "user_1" }),
    ).toBe(false);
    expect(onRedisError).toHaveBeenCalled();

    currentTime += LIMITS.mcpGatewayRateLimitWindowMs;
    expect(
      await limiter.consume({ connectorSlug: "registry", userId: "user_1" }),
    ).toBe(true);
  });
});
