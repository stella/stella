import { RedisClient } from "bun";
import { expect, spyOn, test } from "bun:test";

import { createFeedbackIntakeGuards } from "@/api/handlers/feedback/intake-guards";
import { createAuthRateLimitStorage } from "@/api/lib/rate-limit/auth-storage";
import { RedisRateLimitContext } from "@/api/lib/rate-limit/redis-context";
import * as redisClientModule from "@/api/lib/redis-client";
import { createSecurityCanaryAlertDeduplicator } from "@/api/lib/security-canary";
import { createMcpGatewayRateLimiter } from "@/api/mcp/gateway/rate-limit";

const customTimeoutMs = 137;

test.each([
  {
    name: "auth rate-limit storage",
    storeClass: "durable-coordination",
    connectionTimeout: 500,
    construct: async () => {
      createAuthRateLimitStorage();
    },
  },
  {
    name: "API rate limiter",
    storeClass: "durable-coordination",
    connectionTimeout: customTimeoutMs,
    construct: async () => {
      const context = new RedisRateLimitContext({
        commandTimeoutMs: customTimeoutMs,
        failurePolicy: "fail_open_local",
        onRedisError: () => undefined,
      });
      try {
        await context.increment("options");
      } finally {
        context.kill();
      }
    },
  },
  {
    name: "feedback intake",
    storeClass: "durable-coordination",
    connectionTimeout: customTimeoutMs,
    construct: async () => {
      await createFeedbackIntakeGuards({
        commandTimeoutMs: customTimeoutMs,
      }).consumeCounter({
        bucket: "options",
        key: "test",
        max: 1,
        windowMs: 1000,
      });
    },
  },
  {
    name: "MCP gateway rate limiter",
    storeClass: "durable-coordination",
    connectionTimeout: customTimeoutMs,
    construct: async () => {
      await createMcpGatewayRateLimiter({
        commandTimeoutMs: customTimeoutMs,
      }).consume({ connectorSlug: "options", userId: "test" });
    },
  },
  {
    name: "security canary deduplication",
    storeClass: "cache",
    connectionTimeout: customTimeoutMs,
    construct: async () => {
      await createSecurityCanaryAlertDeduplicator({
        commandTimeoutMs: customTimeoutMs,
      })();
    },
  },
])(
  "$name forwards fail-fast options when constructing its default client",
  async ({ construct, connectionTimeout, storeClass }) => {
    const clients: ReturnType<typeof redisClientModule.createRedisClient>[] =
      [];
    const createClient = redisClientModule.createRedisClient;
    const construction = spyOn(
      redisClientModule,
      "createRedisClient",
    ).mockImplementation((options) => {
      const client = createClient(options);
      clients.push(client);
      return client;
    });
    const connect = spyOn(RedisClient.prototype, "connect").mockResolvedValue(
      undefined,
    );
    const send = spyOn(RedisClient.prototype, "send").mockImplementation(
      async (command) =>
        command === "INFO" ? "maxmemory_policy:noeviction\r\n" : 1,
    );
    try {
      await construct();
      expect(construction).toHaveBeenCalledTimes(1);
      expect(construction).toHaveBeenCalledWith({
        storeClass,
        overrides: { connectionTimeout, enableOfflineQueue: false },
      });
      expect(clients).toHaveLength(1);
    } finally {
      for (const client of clients) {
        client.close();
      }
      construction.mockRestore();
      connect.mockRestore();
      send.mockRestore();
    }
  },
);
