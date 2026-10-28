import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { createHttpApp } from "@/api/http/app";
import { mount, routes } from "@/api/http/route";
import { parseTrustedProxies } from "@/api/lib/client-ip";
import { defineEndpoint } from "@/api/lib/endpoints";
import { errorBoundary } from "@/api/lib/observability/request-lifecycle";
import { rateLimit, scopedRateLimitKey } from "@/api/lib/rate-limit/rate-limit";
import {
  createRedisRateLimitRequestKey,
  RedisRateLimitContext,
} from "@/api/lib/rate-limit/redis-context";
import { serveForTest } from "@/api/tests/helpers/test-server";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import { createPublicSanctionsRateLimitOptions } from "./public-corpus-rate-limits";

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

const createFixture = async (
  peer: string | null = "10.0.0.5",
  addressPolicy: "configured" | "default" = "configured",
) => {
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
  const options = createPublicSanctionsRateLimitOptions();
  await options.context.kill();
  // The viewer's socket peer, as the edge proxy (or nothing) presents it.
  const peerServer = {
    requestIP: () => (peer === null ? null : { address: peer }),
  };
  const server = serveForTest(
    createHttpApp({
      middleware: [errorBoundary],
      routes: mount(
        [
          routes({
            "/search": {
              POST: defineEndpoint.public(
                { body: v.object({ name: v.string() }) },
                () => "ok",
              ),
            },
          }),
        ],
        {
          middleware: [
            rateLimit({
              ...options,
              context,
              generator: async (incoming) =>
                addressPolicy === "default"
                  ? await options.generator(incoming, peerServer)
                  : createRedisRateLimitRequestKey({
                      counterKey: scopedRateLimitKey({
                        scope: "public-sanctions-search",
                        request: incoming,
                        server: peerServer,
                        clientAddressOptions: { trusted, edgeHeader: null },
                      }),
                      requestId: Bun.randomUUIDv7(),
                    }),
            }),
          ],
        },
      ),
    }),
  );
  const close = async () => {
    await server.stop();
    context.kill();
  };
  return { server, close, counts, options };
};

describe("anonymous sanctions search rate limiting", () => {
  test("limits each resolved viewer to 20 searches behind a shared peer", async () => {
    const { server, close, counts, options } = await createFixture();
    try {
      for (let index = 0; index < 20; index += 1) {
        expect((await server.fetch(request("192.0.2.1"))).status).toBe(200);
      }
      const limited = await server.fetch(request("192.0.2.1"));
      expect(limited.status).toBe(429);
      expect(await limited.text()).toBe("rate-limit reached");
      expect(limited.headers.get("RateLimit-Limit")).toBe("20");
      expect(limited.headers.get("Retry-After")).toBe("60");
      expect((await server.fetch(request("192.0.2.2"))).status).toBe(200);
      expect([...counts.keys()]).toEqual([
        "api-ratelimit:{public-sanctions-search:192.0.2.1}",
        "api-ratelimit:{public-sanctions-search:192.0.2.2}",
      ]);
      expect(options.duration).toBe(60_000);
    } finally {
      await close();
    }
  });

  test("ignores changing leftmost forwarded addresses before the actual viewer", async () => {
    const { server, close, counts } = await createFixture();
    try {
      for (let index = 0; index < 20; index += 1) {
        expect(
          (await server.fetch(request(`192.0.2.${index + 1}, 198.51.100.7`)))
            .status,
        ).toBe(200);
      }
      expect(
        (await server.fetch(request("203.0.113.99, 198.51.100.7"))).status,
      ).toBe(429);
      expect([...counts.keys()]).toEqual([
        "api-ratelimit:{public-sanctions-search:198.51.100.7}",
      ]);
    } finally {
      await close();
    }
  });

  test("canonicalizes IPv6 viewers and shares their 64 bit prefix", async () => {
    const { server, close, counts } = await createFixture();
    try {
      for (let index = 0; index < 20; index += 1) {
        expect(
          (await server.fetch(request(`2001:db8:1:2::${index + 1}`))).status,
        ).toBe(200);
      }
      expect(
        (await server.fetch(request("2001:0db8:0001:0002:ffff:ffff:ffff:ffff")))
          .status,
      ).toBe(429);
      expect((await server.fetch(request("2001:db8:1:3::1"))).status).toBe(200);
      expect([...counts.keys()]).toEqual([
        "api-ratelimit:{public-sanctions-search:2001:db8:1:2::}",
        "api-ratelimit:{public-sanctions-search:2001:db8:1:3::}",
      ]);
    } finally {
      await close();
    }
  });

  test("IPv4 mapped IPv6 viewers retain the full IPv4 identity", async () => {
    const { server, close, counts } = await createFixture();
    try {
      expect((await server.fetch(request("::ffff:192.0.2.1"))).status).toBe(
        200,
      );
      expect((await server.fetch(request("::ffff:c000:201"))).status).toBe(200);
      expect((await server.fetch(request("192.0.2.1"))).status).toBe(200);
      expect((await server.fetch(request("::ffff:192.0.2.2"))).status).toBe(
        200,
      );
      expect([...counts.entries()]).toEqual([
        ["api-ratelimit:{public-sanctions-search:192.0.2.1}", 3],
        ["api-ratelimit:{public-sanctions-search:192.0.2.2}", 1],
      ]);
    } finally {
      await close();
    }
  });

  test("bounds requests with no address in the shared scope counter", async () => {
    const { server, close, counts } = await createFixture(null, "default");
    try {
      for (let index = 0; index < 20; index += 1) {
        expect(
          (await server.fetch(request(`192.0.2.${index + 1}`))).status,
        ).toBe(200);
      }
      const response = await server.fetch(request("198.51.100.1"));
      expect(response.status).toBe(429);
      expect(await response.text()).toBe("rate-limit reached");
      expect([...counts.entries()]).toEqual([
        ["api-ratelimit:{public-sanctions-search}", 21],
      ]);
    } finally {
      await close();
    }
  });

  test("default production options preserve peer keys and the standard 429", async () => {
    const { server, close, counts } = await createFixture(
      "192.0.2.1",
      "default",
    );
    try {
      for (let index = 0; index < 20; index += 1) {
        expect(
          (await server.fetch(request(`198.51.100.${index + 1}`))).status,
        ).toBe(200);
      }
      const response = await server.fetch(request("203.0.113.1"));
      expect(response.status).toBe(429);
      expect(await response.text()).toBe("rate-limit reached");
      expect([...counts.entries()]).toEqual([
        ["api-ratelimit:{public-sanctions-search:192.0.2.1}", 21],
      ]);
    } finally {
      await close();
    }
  });

  for (const { name, body, status } of [
    { name: "malformed JSON", body: "{", status: 400 },
    { name: "invalid schema", body: JSON.stringify({ name: 1 }), status: 422 },
  ]) {
    test(`counts ${name} against viewer and shared scope counters`, async () => {
      const resolved = await createFixture();
      try {
        expect(
          (await resolved.server.fetch(request("192.0.2.1", body))).status,
        ).toBe(status);
        expect([...resolved.counts.entries()]).toEqual([
          ["api-ratelimit:{public-sanctions-search:192.0.2.1}", 1],
        ]);
      } finally {
        await resolved.close();
      }
      const missing = await createFixture(null, "default");
      try {
        const response = await missing.server.fetch(request("192.0.2.1", body));
        expect(response.status).toBe(status);
        expect([...missing.counts.entries()]).toEqual([
          ["api-ratelimit:{public-sanctions-search}", 1],
        ]);
      } finally {
        await missing.close();
      }
    });
  }
});

test("production sanctions rate limiting fails closed on Redis failure", async () => {
  const options = createPublicSanctionsRateLimitOptions();
  try {
    expect(options.context).toBeInstanceOf(RedisRateLimitContext);
    // Inspect the actual factory's policy without connecting to an ambient Redis.
    expect(
      asTestRaw<{ failurePolicy: string }>(options.context).failurePolicy,
    ).toBe("fail_closed");
  } finally {
    await options.context.kill();
  }
});
