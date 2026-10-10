import { describe, expect, test } from "bun:test";

import { createAuthRateLimitStorage } from "@/api/lib/rate-limit/auth-storage";
import { createRedisClient } from "@/api/lib/redis-client";
import { coordinationKey } from "@/api/lib/redis-keys";

if (
  process.env["STELLA_RUN_VALKEY_TESTS"] !== "true" ||
  !process.env["REDIS_URL"]
) {
  describe.skip("auth admission reservations (valkey)", () => {
    test("requires Valkey", () => {});
  });
} else {
  test("atomic admission settlement preserves other requests and replacement windows", async () => {
    const redis = createRedisClient({ storeClass: "durable-coordination" });
    await redis.connect();
    const key = `token-admission-${Bun.randomUUIDv7()}`;
    const counter = coordinationKey({
      scope: "auth-ratelimit",
      slot: key,
      suffix: "admission",
    });
    const storage = createAuthRateLimitStorage({ redis });
    const rule = { max: 3, window: 60 };
    try {
      const decisions = await Promise.all(
        Array.from(
          { length: 12 },
          async () => await storage.reserve(key, rule),
        ),
      );
      const admitted = decisions.filter(
        (decision) => decision.type === "reserved",
      );
      expect(admitted).toHaveLength(rule.max);
      expect(await redis.send("HGET", [counter, "count"])).toBe("3");
      const old = admitted.at(0);
      expect(old).toBeDefined();
      if (!old) {
        return;
      }
      await storage.settle(old.reservation, "accepted");
      await storage.settle(old.reservation, "accepted");
      expect(await redis.send("HGET", [counter, "count"])).toBe("2");
      const successor = await storage.reserve(key, rule);
      expect(successor.type).toBe("reserved");
      if (successor.type !== "reserved") {
        return;
      }
      await redis.send("DEL", [counter]);
      const current = await storage.reserve(key, rule);
      expect(current.type).toBe("reserved");
      await storage.settle(successor.reservation, "accepted");
      expect(await redis.send("HGET", [counter, "count"])).toBe("1");
      if (current.type !== "reserved") {
        return;
      }
      await storage.settle(current.reservation, "rejected");
      expect(await redis.send("HGET", [counter, "count"])).toBe("1");
    } finally {
      await redis.send("DEL", [counter]);
      redis.close();
    }
  });
}
