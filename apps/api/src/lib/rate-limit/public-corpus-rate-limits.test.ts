import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { STELLA_API_VERSION_PREFIX } from "@stll/api-contract";

import { env } from "@/api/env";
import { createHttpApp } from "@/api/http/app";
import { mount, routes } from "@/api/http/route";
import type { Middleware, RouteTable } from "@/api/http/route";
import { defineEndpoint } from "@/api/lib/endpoints";
import { errorBoundary } from "@/api/lib/observability/request-lifecycle";
import {
  resetMetricLineSinkForTesting,
  setMetricLineSinkForTesting,
} from "@/api/lib/observability/request-metrics";
import { createPublicCorpusRateLimitComposition } from "@/api/lib/rate-limit/public-corpus-rate-limit-composition";
import {
  getPublicCorpusClassPolicy,
  PUBLIC_CORPUS_ROUTE_POLICY,
} from "@/api/public-corpus-policy";
import { serveForTest } from "@/api/tests/helpers/test-server";
import type { TestServer } from "@/api/tests/helpers/test-server";

import {
  createPublicCorpusAddressRateLimitOptions,
  createPublicCorpusGlobalRateLimitOptions,
} from "./public-corpus-rate-limits";
import {
  InMemoryRateLimitContext,
  rateLimit,
  scopedGenerator,
} from "./rate-limit";
import {
  type createRedisRateLimit,
  RedisRateLimitContext,
} from "./redis-context";

const request = (path: string, method = "GET") =>
  new Request(`http://localhost${STELLA_API_VERSION_PREFIX}${path}`, {
    method,
  });

/**
 * The socket peer a counter key reads for a test request. Every request is
 * sent from the same local socket, so the fixture states the peer it stands
 * for; only the test bindings' key generators read it.
 */
const TEST_PEER_HEADER = "x-test-socket-peer";

const createBindings = () => {
  const contexts = new Map<string, InMemoryRateLimitContext>();
  const increments = new Map<string, number>();
  const optionsByScope = new Map<
    string,
    Parameters<typeof createRedisRateLimit>[0]
  >();
  const binding: typeof createRedisRateLimit = (options) => {
    if (contexts.has(options.scope)) {
      panic("Duplicate counter context");
    }
    const context = new InMemoryRateLimitContext();
    contexts.set(options.scope, context);
    optionsByScope.set(options.scope, options);
    const generator =
      options.counterKeyGenerator ?? scopedGenerator(options.scope);
    return {
      context: {
        init: (configuration) => context.init(configuration),
        increment: (key, duration, requestTime) => {
          increments.set(
            options.scope,
            (increments.get(options.scope) ?? 0) + 1,
          );
          return context.increment(key, duration, requestTime);
        },
        complete: (key) => context.complete(key),
        decrement: (key) => context.decrement(key),
        kill: () => context.kill(),
      },
      generator: async (incoming, server) => {
        const peer = incoming.headers.get(TEST_PEER_HEADER);
        return await generator(
          incoming,
          peer === null ? server : { requestIP: () => ({ address: peer }) },
        );
      },
    };
  };
  return {
    binding,
    optionsByScope,
    increments,
    send: async ({ server, incoming, address }: PeerRequestOptions) => {
      const headers = new Headers(incoming.headers);
      headers.set(TEST_PEER_HEADER, address);
      return await server.fetch(new Request(incoming, { headers }));
    },
    kill: () => {
      for (const context of contexts.values()) {
        context.kill();
      }
    },
  };
};

type PeerRequestOptions = {
  server: Pick<TestServer, "fetch">;
  incoming: Request;
  address: string;
};

const answering = (body: string) => defineEndpoint.public({}, () => body);

/**
 * Serve `table` under the API version prefix behind the given stages, as the
 * route table mounts the public corpus routes, on a real `Bun.serve`.
 */
const serveVersioned = (
  table: RouteTable,
  middleware: readonly Middleware[],
): TestServer =>
  serveForTest(
    createHttpApp({
      middleware: [errorBoundary],
      routes: mount([routes(table)], {
        prefix: STELLA_API_VERSION_PREFIX,
        middleware,
      }),
    }),
  );

const createApp = (binding: typeof createRedisRateLimit): TestServer =>
  serveVersioned(
    {
      "/law/statutes/search": { GET: answering("search") },
      "/case/decisions/search": { POST: answering("search") },
      "/law/statutes/facets": { GET: answering("aggregate") },
      "/case/decisions/facets": { GET: answering("aggregate") },
      "/law/sitemap/shards": { GET: answering("sitemap") },
      "/case/sitemap/shards": { GET: answering("sitemap") },
      "/law/statutes": { GET: answering("browse") },
    },
    createPublicCorpusRateLimitComposition({ createRedisBinding: binding }),
  );

type AdmissionCountOptions = {
  lines: string[];
  routeClass: string;
  outcome: "acquired" | "refused";
};
const admissionCount = ({
  lines,
  routeClass,
  outcome,
}: AdmissionCountOptions) =>
  lines.filter((line) => {
    const value: unknown = JSON.parse(line);
    return (
      typeof value === "object" &&
      value !== null &&
      "class" in value &&
      "outcome" in value &&
      value.class === routeClass &&
      value.outcome === outcome
    );
  }).length;

describe("public corpus fleet request budgets", () => {
  for (const refused of [
    { path: "/law/statutes/search/", method: "HEAD" },
    { path: "/case/decisions/search/", method: "POST" },
  ] as const) {
    test(`statute and case-law searches from one address share one budget: refuses ${refused.method} ${refused.path}`, async () => {
      const bindings = createBindings();
      await using server = createApp(bindings.binding);
      const { max } = getPublicCorpusClassPolicy().classes.search.address;
      const alternating = [
        { path: "/law/statutes/search", method: "GET" },
        { path: "/case/decisions/search", method: "POST" },
        { path: "/law/statutes/search/", method: "HEAD" },
        { path: "/case/decisions/search/", method: "POST" },
      ] as const;
      try {
        for (let index = 0; index < max; index += 1) {
          const route = alternating.at(index % alternating.length);
          if (route === undefined) {
            panic("Missing alternating search route");
          }
          expect(
            (
              await bindings.send({
                server,
                incoming: request(route.path, route.method),
                address: "192.0.2.1",
              })
            ).status,
          ).toBe(200);
        }
        const limited = await bindings.send({
          server,
          incoming: request(refused.path, refused.method),
          address: "192.0.2.1",
        });
        expect(limited.status).toBe(429);
        expect(limited.headers.get("RateLimit-Limit")).toBe(String(max));
        expect(limited.headers.get("Retry-After")).toMatch(/^\d+$/u);
        expect(Object.fromEntries(bindings.increments)).toEqual({
          "public-corpus-search": max + 1,
          "public-corpus-global-search": max,
        });
        for (const route of alternating) {
          expect(
            (
              await bindings.send({
                server,
                incoming: request(route.path, route.method),
                address: "192.0.2.2",
              })
            ).status,
          ).toBe(200);
        }
      } finally {
        bindings.kill();
      }
    });
  }

  test("accepted requests report the tightest applicable address or fleet policy", async () => {
    const bindings = createBindings();
    const previous = env.PUBLIC_CORPUS_SITEMAP_GLOBAL_MAX;
    const previousAggregate = env.PUBLIC_CORPUS_AGGREGATE_GLOBAL_MAX;
    try {
      env.PUBLIC_CORPUS_SITEMAP_GLOBAL_MAX = 100;
      env.PUBLIC_CORPUS_AGGREGATE_GLOBAL_MAX = 120;
      await using server = createApp(bindings.binding);
      for (const { path, limit } of [
        { path: "/law/statutes/search", limit: 30 },
        { path: "/law/statutes/facets", limit: 60 },
        { path: "/law/sitemap/shards", limit: 10 },
      ]) {
        const response = await bindings.send({
          server,
          incoming: request(path),
          address: "192.0.2.1",
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("RateLimit-Limit")).toBe(String(limit));
        expect(response.headers.get("RateLimit-Remaining")).toBe(
          String(limit - 1),
        );
      }
    } finally {
      env.PUBLIC_CORPUS_SITEMAP_GLOBAL_MAX = previous;
      env.PUBLIC_CORPUS_AGGREGATE_GLOBAL_MAX = previousAggregate;
      bindings.kill();
    }
  });

  for (const { path, method, routeClass } of [
    { path: "/law/statutes/search", method: "GET", routeClass: "search" },
    { path: "/case/decisions/search", method: "POST", routeClass: "search" },
    { path: "/law/statutes/facets", method: "GET", routeClass: "aggregate" },
    { path: "/law/sitemap/shards", method: "GET", routeClass: "sitemap" },
  ] as const) {
    test(`capacity refusals leave fleet budgets available after admitted work finishes: ${method} ${path}`, async () => {
      const bindings = createBindings();
      const policy = getPublicCorpusClassPolicy();
      const capacity =
        routeClass === "sitemap"
          ? policy.totalConcurrency
          : policy.classes[routeClass].concurrency;
      const completion = Promise.withResolvers<string>();
      const entered = Promise.withResolvers<undefined>();
      let started = 0;
      const work = async ({ request: incoming }: { request: Request }) => {
        expect(incoming.method).toBe(method);
        started += 1;
        if (started === capacity) {
          entered.resolve(undefined);
        }
        return await completion.promise;
      };
      // Refusals are what this measures; skip the brief wait for a slot.
      const composition = createPublicCorpusRateLimitComposition({
        createRedisBinding: bindings.binding,
        concurrency: { waitMsOf: () => 0 },
      });
      const working = defineEndpoint.public({}, work);
      await using server = serveVersioned(
        {
          "/law/statutes/search": { GET: working },
          "/case/decisions/search": { POST: working },
          "/law/statutes/facets": { GET: working },
          "/law/sitemap/shards": { GET: working },
        },
        composition,
      );
      const running = Array.from(
        { length: capacity },
        async (_, index) =>
          await bindings.send({
            server,
            incoming: request(path, method),
            address: `192.0.2.${index + 1}`,
          }),
      );
      try {
        await Promise.race([
          entered.promise,
          Promise.all(running).then((responses) =>
            panic(
              `Capacity fixture completed before admission: ${responses.map((response) => response.status).join(",")}`,
            ),
          ),
        ]);
        const scope = `public-corpus-global-${routeClass}`;
        expect(bindings.increments.get(scope)).toBe(capacity);
        for (
          let index = 0;
          index < policy.classes[routeClass].global.max + 1;
          index += 1
        ) {
          const response = await bindings.send({
            server,
            incoming: request(path, method),
            address: `198.51.100.${index + 1}`,
          });
          expect(response.status).toBe(429);
        }
        expect(started).toBe(capacity);
        expect(bindings.increments.get(scope)).toBe(capacity);
        completion.resolve("done");
        for (const response of await Promise.all(running)) {
          expect(response.status).toBe(200);
        }
        expect(
          (
            await bindings.send({
              server,
              incoming: request(path, method),
              address: "203.0.113.1",
            })
          ).status,
        ).toBe(200);
        expect(bindings.increments.get(scope)).toBe(capacity + 1);
      } finally {
        completion.resolve("done");
        await Promise.all(running);
        bindings.kill();
      }
    });
  }

  const searchRoutes = Object.entries(PUBLIC_CORPUS_ROUTE_POLICY)
    .filter(([, routeClass]) => routeClass === "search")
    .flatMap(([route]) => {
      const separator = route.indexOf(" ");
      const method = route.slice(0, separator);
      const path = route.slice(separator + 1);
      return (method === "GET" ? [method, "HEAD"] : [method]).flatMap(
        (requestMethod) =>
          [path, `${path}/`].map((requestPath) => ({
            path: requestPath,
            method: requestMethod,
          })),
      );
    });
  for (const { path, method } of searchRoutes) {
    test(`search address refusals preserve fleet capacity without double charging: ${method} ${path}`, async () => {
      const previous = env.PUBLIC_CORPUS_SEARCH_GLOBAL_MAX;
      const bindings = createBindings();
      try {
        env.PUBLIC_CORPUS_SEARCH_GLOBAL_MAX = 7;
        await using server = createApp(bindings.binding);
        for (let index = 0; index < 3; index += 1) {
          expect(
            (
              await bindings.send({
                server,
                incoming: request(path, method),
                address: "192.0.2.1",
              })
            ).status,
          ).toBe(200);
        }
        expect(
          (
            await bindings.send({
              server,
              incoming: request(path, method),
              address: "192.0.2.1",
            })
          ).status,
        ).toBe(429);
        // Only the class buckets named by the policy table charge search.
        expect(Object.fromEntries(bindings.increments)).toEqual({
          "public-corpus-search": 4,
          "public-corpus-global-search": 3,
        });
        expect(
          (
            await bindings.send({
              server,
              incoming: request(path, method),
              address: "192.0.2.2",
            })
          ).status,
        ).toBe(200);
        expect(bindings.increments.get("public-corpus-global-search")).toBe(4);
      } finally {
        env.PUBLIC_CORPUS_SEARCH_GLOBAL_MAX = previous;
        bindings.kill();
      }
    });
  }

  test("distinct client addresses share the global budget across law and case routes", async () => {
    const previous = {
      search: env.PUBLIC_CORPUS_SEARCH_GLOBAL_MAX,
      aggregate: env.PUBLIC_CORPUS_AGGREGATE_GLOBAL_MAX,
      sitemap: env.PUBLIC_CORPUS_SITEMAP_GLOBAL_MAX,
    };
    const bindings = createBindings();
    const lines: string[] = [];
    setMetricLineSinkForTesting((line) => {
      lines.push(line);
    });
    try {
      env.PUBLIC_CORPUS_SEARCH_GLOBAL_MAX = 3;
      env.PUBLIC_CORPUS_AGGREGATE_GLOBAL_MAX = 3;
      env.PUBLIC_CORPUS_SITEMAP_GLOBAL_MAX = 3;
      await using server = createApp(bindings.binding);
      for (const classRoutes of [
        [
          { path: "/law/statutes/search", method: "GET" },
          { path: "/case/decisions/search", method: "POST" },
        ],
        [
          { path: "/law/statutes/facets", method: "GET" },
          { path: "/case/decisions/facets", method: "GET" },
        ],
        [
          { path: "/law/sitemap/shards", method: "GET" },
          { path: "/case/sitemap/shards", method: "GET" },
        ],
      ]) {
        for (let index = 0; index < 4; index += 1) {
          const route = classRoutes.at(index % classRoutes.length);
          if (!route) {
            panic("Missing test route");
          }
          const response = await bindings.send({
            server,
            incoming: request(route.path, route.method),
            address: `192.0.2.${index + 1}`,
          });
          expect(response.status).toBe(index < 3 ? 200 : 429);
          if (index === 3) {
            expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(
              0,
            );
          }
        }
      }
      expect(
        (
          await bindings.send({
            server,
            incoming: request("/law/statutes"),
            address: "192.0.2.1",
          })
        ).status,
      ).toBe(200);
      expect(lines).toHaveLength(3);
      for (const routeClass of ["search", "aggregate", "sitemap"]) {
        expect(admissionCount({ lines, routeClass, outcome: "acquired" })).toBe(
          0,
        );
        expect(admissionCount({ lines, routeClass, outcome: "refused" })).toBe(
          1,
        );
      }
      for (const line of lines) {
        expect(JSON.parse(line)).toMatchObject({
          _aws: {
            CloudWatchMetrics: [
              {
                Dimensions: [["class", "outcome"]],
                Metrics: [{ Name: "PublicCorpusAdmissions", Unit: "Count" }],
              },
            ],
          },
          PublicCorpusAdmissions: 1,
        });
        expect(Object.keys(JSON.parse(line)).toSorted()).toEqual(
          ["PublicCorpusAdmissions", "_aws", "class", "outcome"].toSorted(),
        );
      }
    } finally {
      env.PUBLIC_CORPUS_SEARCH_GLOBAL_MAX = previous.search;
      env.PUBLIC_CORPUS_AGGREGATE_GLOBAL_MAX = previous.aggregate;
      env.PUBLIC_CORPUS_SITEMAP_GLOBAL_MAX = previous.sitemap;
      bindings.kill();
      resetMetricLineSinkForTesting();
    }
  });

  test("global counter keys ignore peer addresses while address budgets separate them", async () => {
    const bindings = createBindings();
    try {
      for (const routeClass of ["search", "aggregate", "sitemap"] as const) {
        const options = createPublicCorpusGlobalRateLimitOptions(
          routeClass,
          bindings.binding,
        );
        const incoming = request("/law/statutes/search");
        expect(
          await options.generator(incoming, {
            requestIP: () => ({ address: "192.0.2.1" }),
          }),
        ).toBe(`public-corpus-global-${routeClass}`);
        expect(
          await options.generator(incoming, {
            requestIP: () => ({ address: "192.0.2.2" }),
          }),
        ).toBe(`public-corpus-global-${routeClass}`);
        expect(
          bindings.optionsByScope.get(`public-corpus-global-${routeClass}`),
        ).toMatchObject({
          localMax: Math.floor(
            options.max / env.PUBLIC_CORPUS_ASSUMED_REPLICAS,
          ),
          failurePolicy: "fail_open_local",
        });
      }
      for (const routeClass of ["search", "aggregate", "sitemap"] as const) {
        const options = createPublicCorpusAddressRateLimitOptions(
          routeClass,
          bindings.binding,
        );
        expect(options.max).toBe(
          getPublicCorpusClassPolicy().classes[routeClass].address.max,
        );
        const first = await options.generator(request("/law/statutes/facets"), {
          requestIP: () => ({ address: "192.0.2.1" }),
        });
        const second = await options.generator(
          request("/law/statutes/facets"),
          { requestIP: () => ({ address: "192.0.2.2" }) },
        );
        expect(first).not.toBe(second);
      }
    } finally {
      bindings.kill();
    }
  });

  test("aggregate and sitemap per-address caps are isolated from ordinary navigation", async () => {
    const bindings = createBindings();
    const previousSitemap = env.PUBLIC_CORPUS_SITEMAP_GLOBAL_MAX;
    const previousAggregate = env.PUBLIC_CORPUS_AGGREGATE_GLOBAL_MAX;
    env.PUBLIC_CORPUS_SITEMAP_GLOBAL_MAX = 100;
    env.PUBLIC_CORPUS_AGGREGATE_GLOBAL_MAX = 100;
    await using server = createApp(bindings.binding);
    const lines: string[] = [];
    setMetricLineSinkForTesting((line) => {
      lines.push(line);
    });
    try {
      for (const { path, max, routeClass } of [
        { path: "/law/statutes/facets", max: 50, routeClass: "aggregate" },
        { path: "/law/sitemap/shards", max: 10, routeClass: "sitemap" },
      ]) {
        for (let index = 0; index < max; index += 1) {
          expect(
            (
              await bindings.send({
                server,
                incoming: request(path),
                address: "192.0.2.1",
              })
            ).status,
          ).toBe(200);
        }
        expect(
          bindings.increments.get(`public-corpus-global-${routeClass}`),
        ).toBe(max);
        expect(
          (
            await bindings.send({
              server,
              incoming: request(path),
              address: "192.0.2.1",
            })
          ).status,
        ).toBe(429);
        expect(
          bindings.increments.get(`public-corpus-global-${routeClass}`),
        ).toBe(max);
        expect(
          (
            await bindings.send({
              server,
              incoming: request(path),
              address: "192.0.2.2",
            })
          ).status,
        ).toBe(200);
        expect(
          bindings.increments.get(`public-corpus-global-${routeClass}`),
        ).toBe(max + 1);
        expect(
          (
            await bindings.send({
              server,
              incoming: request("/law/statutes"),
              address: "192.0.2.1",
            })
          ).status,
        ).toBe(200);
      }
      expect(lines).toEqual([]);
    } finally {
      env.PUBLIC_CORPUS_SITEMAP_GLOBAL_MAX = previousSitemap;
      env.PUBLIC_CORPUS_AGGREGATE_GLOBAL_MAX = previousAggregate;
      bindings.kill();
      resetMetricLineSinkForTesting();
    }
  });

  test("Redis outage fallback retains warm traffic and emits a metric only on refusal", async () => {
    let available = true;
    let count = 0;
    const lines: string[] = [];
    const bindings = createBindings();
    const previous = env.PUBLIC_CORPUS_SEARCH_GLOBAL_MAX;
    setMetricLineSinkForTesting((line) => {
      lines.push(line);
    });
    try {
      env.PUBLIC_CORPUS_SEARCH_GLOBAL_MAX =
        2 * env.PUBLIC_CORPUS_ASSUMED_REPLICAS;
      const options = createPublicCorpusGlobalRateLimitOptions(
        "search",
        bindings.binding,
      );
      const captured = bindings.optionsByScope.get(
        "public-corpus-global-search",
      );
      if (!captured?.onLocalFallback || captured.localMax === undefined) {
        panic("Global policy must report local fallback");
      }
      expect(captured.localMax).toBe(2);
      const context = new RedisRateLimitContext({
        failurePolicy: captured.failurePolicy,
        localMax: captured.localMax,
        onRedisError: () => undefined,
        onLocalFallback: captured.onLocalFallback,
        createRedis: () => ({
          send: async () => {
            if (!available) {
              throw new Error("test Redis outage");
            }
            count += 1;
            return [count, options.duration];
          },
        }),
      });
      context.init({ duration: options.duration });
      try {
        expect(
          (await context.increment(captured.scope, options.duration)).count,
        ).toBe(1);
        available = false;
        expect(
          (await context.increment(captured.scope, options.duration)).count,
        ).toBe(2);
        expect(
          (await context.increment(captured.scope, options.duration)).count,
        ).toBeGreaterThan(options.max);
        expect(lines).toEqual([]);
        await using server = serveVersioned(
          { "/case/decisions/search": { POST: answering("search") } },
          [rateLimit({ ...options, context })],
        );
        const response = await server.fetch(
          request("/case/decisions/search", "POST"),
        );
        expect(response.status).toBe(429);
        expect(lines).toHaveLength(1);
        for (const line of lines) {
          expect(JSON.parse(line)).toMatchObject({
            class: "search",
            outcome: "refused",
            PublicCorpusAdmissions: 1,
            _aws: {
              CloudWatchMetrics: [{ Dimensions: [["class", "outcome"]] }],
            },
          });
        }
      } finally {
        context.kill();
      }
    } finally {
      env.PUBLIC_CORPUS_SEARCH_GLOBAL_MAX = previous;
      bindings.kill();
      resetMetricLineSinkForTesting();
    }
  });

  test("a zero local fallback budget refuses the first request during an outage", async () => {
    const context = new RedisRateLimitContext({
      failurePolicy: "fail_open_local",
      localMax: 0,
      onRedisError: () => undefined,
      createRedis: () => ({
        send: async () => {
          throw new Error("test Redis outage");
        },
      }),
    });
    context.init({ duration: 60_000 });
    try {
      expect(
        (await context.increment("fleet", 60_000, 1000)).count,
      ).toBeGreaterThan(480);
    } finally {
      context.kill();
    }
  });
});
