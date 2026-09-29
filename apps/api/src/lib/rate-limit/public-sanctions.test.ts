import { describe, expect, test } from "bun:test";
import Elysia, { t } from "elysia";

import { parseTrustedProxies } from "@/api/lib/client-ip";
import { answerRequestError } from "@/api/lib/observability/request-lifecycle";
import { RedisRateLimitContext } from "@/api/lib/rate-limit/redis-context";

import {
  createPublicSanctionsRateLimit,
  createPublicSanctionsRateLimitOptions,
} from "./public-sanctions";

const request = (
  forwardedFor: string,
  body = JSON.stringify({ name: "Example" }),
) =>
  new Request("http://localhost/search", {
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": forwardedFor,
    },
    method: "POST",
    body,
  });

const createFixture = async (peer: string | null = "10.0.0.5") => {
  const trusted = parseTrustedProxies("10.0.0.0/8");
  const counts = new Map<string, number>();
  const context = new RedisRateLimitContext({
    createRedis: () => ({
      send: async (_command, args) => {
        const key = args.at(2);
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
  const options = createPublicSanctionsRateLimitOptions({
    clientAddressOptions: { trusted, edgeHeader: null },
  });
  await options.context.kill();
  const server = {
    requestIP: () => (peer === null ? null : { address: peer }),
  };
  const app = new Elysia()
    .onError(answerRequestError)
    .use(
      createPublicSanctionsRateLimit({
        ...options,
        context,
        generator: (incoming) => options.generator(incoming, server),
      }),
    )
    .post("/search", () => "ok", { body: t.Object({ name: t.String() }) });
  return { app, context, counts, options };
};

describe("anonymous sanctions search rate limiting", () => {
  test("limits each resolved viewer to 20 searches behind a shared peer", async () => {
    const { app, context, counts, options } = await createFixture();
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

  test("ignores changing leftmost forwarded addresses before the actual viewer", async () => {
    const { app, context, counts } = await createFixture();
    try {
      for (let index = 0; index < 20; index += 1) {
        expect(
          (await app.handle(request(`192.0.2.${index + 1}, 198.51.100.7`)))
            .status,
        ).toBe(200);
      }
      expect(
        (await app.handle(request("203.0.113.99, 198.51.100.7"))).status,
      ).toBe(429);
      expect([...counts.keys()]).toEqual([
        "api-ratelimit:{public-sanctions-search:198.51.100.7}",
      ]);
    } finally {
      await context.kill();
    }
  });

  test("canonicalizes IPv6 viewers and shares their 64 bit prefix", async () => {
    const { app, context, counts } = await createFixture();
    try {
      for (let index = 0; index < 20; index += 1) {
        expect(
          (await app.handle(request(`2001:db8:1:2::${index + 1}`))).status,
        ).toBe(200);
      }
      expect(
        (await app.handle(request("2001:0db8:0001:0002:ffff:ffff:ffff:ffff")))
          .status,
      ).toBe(429);
      expect((await app.handle(request("2001:db8:1:3::1"))).status).toBe(200);
      expect([...counts.keys()]).toEqual([
        "api-ratelimit:{public-sanctions-search:2001:db8:1:2::}",
        "api-ratelimit:{public-sanctions-search:2001:db8:1:3::}",
      ]);
    } finally {
      await context.kill();
    }
  });

  test("IPv4 mapped IPv6 viewers retain the full IPv4 identity", async () => {
    const { app, context, counts } = await createFixture();
    try {
      expect((await app.handle(request("::ffff:192.0.2.1"))).status).toBe(200);
      expect((await app.handle(request("::ffff:c000:201"))).status).toBe(200);
      expect((await app.handle(request("192.0.2.1"))).status).toBe(200);
      expect((await app.handle(request("::ffff:192.0.2.2"))).status).toBe(200);
      expect([...counts.entries()]).toEqual([
        ["api-ratelimit:{public-sanctions-search:192.0.2.1}", 3],
        ["api-ratelimit:{public-sanctions-search:192.0.2.2}", 1],
      ]);
    } finally {
      await context.kill();
    }
  });

  test("fails closed without incrementing a counter when no address is available", async () => {
    const { app, context, counts } = await createFixture(null);
    try {
      const response = await app.handle(request("192.0.2.1"));
      expect(response.status).toBe(429);
      const body = await response.text();
      expect(body).not.toContain("192.0.2.1");
      expect(body).not.toContain("x-forwarded-for");
      expect(counts.size).toBe(0);
    } finally {
      await context.kill();
    }
  });

  for (const { name, body, status } of [
    { name: "malformed JSON", body: "{", status: 400 },
    { name: "invalid schema", body: JSON.stringify({ name: 1 }), status: 422 },
  ]) {
    test(`fails closed before answering ${name} when no address is available`, async () => {
      // A resolved request first proves the fixture reaches this failure boundary.
      const resolved = await createFixture();
      try {
        expect(
          (await resolved.app.handle(request("192.0.2.1", body))).status,
        ).toBe(status);
        expect(resolved.counts.size).toBe(1);
      } finally {
        await resolved.context.kill();
      }
      const missing = await createFixture(null);
      try {
        const response = await missing.app.handle(request("192.0.2.1", body));
        expect(response.status).toBe(429);
        const answer = await response.text();
        expect(answer).not.toContain("192.0.2.1");
        expect(answer).not.toContain("x-forwarded-for");
        expect(missing.counts.size).toBe(0);
      } finally {
        await missing.context.kill();
      }
    });
  }
});
