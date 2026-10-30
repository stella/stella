import { describe, expect, test } from "bun:test";

import { createHttpApp } from "@/api/http/app";
import { routes } from "@/api/http/route";
import { defineEndpoint } from "@/api/lib/endpoints";
import { errorBoundary } from "@/api/lib/observability/request-lifecycle";
import { createRedisClient } from "@/api/lib/redis-client";
import { serveForTest } from "@/api/tests/helpers/test-server";

import { createPublicSanctionsRateLimitOptions } from "./public-corpus-rate-limits";
import { rateLimit } from "./rate-limit";
import { RedisRateLimitContext } from "./redis-context";

describe.skipIf(process.env["STELLA_RUN_VALKEY_TESTS"] !== "true")(
  "reachable limiter storage",
  () => {
    test("an exhausted Valkey counter retains the rate-limit refusal", async () => {
      const context = new RedisRateLimitContext({
        failurePolicy: "fail_closed",
        createRedis: () =>
          createRedisClient({ storeClass: "durable-coordination" }),
      });
      const key = Bun.randomUUIDv7();
      const options = createPublicSanctionsRateLimitOptions();
      await options.context.kill();
      await using server = serveForTest(
        createHttpApp({
          middleware: [
            errorBoundary,
            rateLimit({
              ...options,
              context,
              generator: () => key,
            }),
          ],
          routes: routes({
            "/search": { GET: defineEndpoint.public({}, () => "ok") },
          }),
        }),
      );
      try {
        for (let index = 0; index < options.max; index += 1) {
          expect((await server.fetch("http://localhost/search")).status).toBe(
            200,
          );
        }
        const refused = await server.fetch("http://localhost/search");
        expect(refused.status).toBe(429);
        expect(await refused.text()).toBe("rate-limit reached");
        expect(refused.headers.get("RateLimit-Remaining")).toBe("0");
      } finally {
        await context.reset(key);
        context.kill();
      }
    });
  },
);
