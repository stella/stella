import { describe, expect, test } from "bun:test";
import Elysia from "elysia";

import { rateLimit } from "@/api/lib/rate-limit/rate-limit";
import { RedisRateLimitContext } from "@/api/lib/rate-limit/redis-context";

import { createPublicSanctionsRateLimitOptions } from "./public-sanctions";

describe("anonymous sanctions search rate limiting", () => {
  test("limits each IP to 20 searches per minute in a separate bucket", async () => {
    const options = createPublicSanctionsRateLimitOptions();
    await options.context.kill();
    const counts = new Map<string, number>();
    const context = new RedisRateLimitContext({
      createRedis: () => ({
        send: async (_command, args) => {
          const key = args.at(2);
          expect(key).toBeDefined();
          if (key === undefined) {
            throw new TypeError("Missing Redis counter key");
          }
          const count = (counts.get(key) ?? 0) + 1;
          counts.set(key, count);
          return [count, 60_000];
        },
      }),
      failurePolicy: "fail_closed",
      onRedisError: () => undefined,
    });
    const server = {
      requestIP: (request: Request) => ({
        address: request.headers.get("x-test-client-ip") ?? "192.0.2.1",
      }),
    };
    const app = new Elysia()
      .use(
        rateLimit({
          ...options,
          context,
          generator: (request) => options.generator(request, server),
        }),
      )
      .post("/search", () => "ok");
    const request = (address: string) =>
      new Request("http://localhost/search", {
        headers: { "x-test-client-ip": address },
        method: "POST",
      });

    try {
      for (let index = 0; index < 20; index += 1) {
        expect((await app.handle(request("192.0.2.1"))).status).toBe(200);
      }
      const limited = await app.handle(request("192.0.2.1"));
      expect(limited.status).toBe(429);
      expect(limited.headers.get("RateLimit-Limit")).toBe("20");
      expect(limited.headers.get("Retry-After")).toBe("60");
      expect((await app.handle(request("192.0.2.2"))).status).toBe(200);
      expect([...counts.keys()]).toEqual([
        "api-ratelimit:{public-sanctions-search:192.0.2.1}",
        "api-ratelimit:{public-sanctions-search:192.0.2.2}",
      ]);
      expect(options.duration).toBe(60_000);
    } finally {
      await context.kill();
    }
  });
});
