import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";

import { STELLA_API_VERSION_PREFIX } from "@stll/api-contract";

import { env } from "@/api/env";
import { createPublicStatuteSearchRateLimitComposition } from "@/api/handlers/legislation/public-search-rate-limit-composition";
import {
  resetMetricLineSinkForTesting,
  setMetricLineSinkForTesting,
} from "@/api/lib/observability/request-metrics";

import {
  createPublicCorpusAddressRateLimitOptions,
  createPublicCorpusGlobalRateLimitOptions,
} from "./public-corpus-rate-limits";
import {
  InMemoryRateLimitContext,
  rateLimit,
  type RequestIpServer,
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

const createBindings = () => {
  const contexts = new Map<string, InMemoryRateLimitContext>();
  const increments = new Map<string, number>();
  const peers = new WeakMap<Request, RequestIpServer>();
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
        decrement: (key) => context.decrement(key),
        kill: () => context.kill(),
      },
      generator: (incoming, server) =>
        generator(incoming, peers.get(incoming) ?? server),
    };
  };
  return {
    binding,
    optionsByScope,
    increments,
    send: async ({ app, incoming, address }: PeerRequestOptions) => {
      peers.set(incoming, { requestIP: () => ({ address }) });
      return await app.handle(incoming);
    },
    kill: () => {
      for (const context of contexts.values()) {
        context.kill();
      }
    },
  };
};

type PeerRequestOptions = {
  app: { handle: (incoming: Request) => Promise<Response> };
  incoming: Request;
  address: string;
};

const createApp = (binding: typeof createRedisRateLimit) => {
  const composition = createPublicStatuteSearchRateLimitComposition({
    routes: new Elysia().get("/law/statutes/search", () => "search"),
    createRedisBinding: binding,
  });
  return new Elysia().group(STELLA_API_VERSION_PREFIX, (app) =>
    app
      .use(composition.shared)
      .use(composition.publicLegislation)
      .post("/case/decisions/search", () => "search")
      .get("/law/statutes/facets", () => "aggregate")
      .get("/case/decisions/facets", () => "aggregate")
      .get("/law/sitemap/shards", () => "sitemap")
      .get("/case/sitemap/shards", () => "sitemap")
      .get("/law/statutes", () => "browse"),
  );
};

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
  test("distinct client addresses share the global budget across law and case routes", async () => {
    const previous = {
      search: env.PUBLIC_CORPUS_SEARCH_GLOBAL_MAX,
      aggregate: env.PUBLIC_CORPUS_AGGREGATE_GLOBAL_MAX,
      sitemap: env.PUBLIC_CORPUS_SITEMAP_GLOBAL_MAX,
    };
    const bindings = createBindings();
    const lines: string[] = [];
    setMetricLineSinkForTesting((line) => lines.push(line));
    try {
      env.PUBLIC_CORPUS_SEARCH_GLOBAL_MAX = 3;
      env.PUBLIC_CORPUS_AGGREGATE_GLOBAL_MAX = 3;
      env.PUBLIC_CORPUS_SITEMAP_GLOBAL_MAX = 3;
      const app = createApp(bindings.binding);
      for (const routes of [
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
          const route = routes.at(index % routes.length);
          if (!route) {
            panic("Missing test route");
          }
          const response = await bindings.send({
            app,
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
            app,
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
      for (const routeClass of ["aggregate", "sitemap"] as const) {
        const options = createPublicCorpusAddressRateLimitOptions(
          routeClass,
          bindings.binding,
        );
        expect(options.max).toBe(routeClass === "aggregate" ? 60 : 10);
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
    const app = createApp(bindings.binding);
    const lines: string[] = [];
    setMetricLineSinkForTesting((line) => lines.push(line));
    try {
      for (const { path, max, routeClass } of [
        { path: "/law/statutes/facets", max: 60, routeClass: "aggregate" },
        { path: "/law/sitemap/shards", max: 10, routeClass: "sitemap" },
      ]) {
        for (let index = 0; index < max; index += 1) {
          expect(
            (
              await bindings.send({
                app,
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
              app,
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
              app,
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
              app,
              incoming: request("/law/statutes"),
              address: "192.0.2.1",
            })
          ).status,
        ).toBe(200);
      }
      expect(lines).toEqual([]);
    } finally {
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
    setMetricLineSinkForTesting((line) => lines.push(line));
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
      if (!captured?.onLocalFallback) {
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
        const app = new Elysia()
          .use(rateLimit({ ...options, context }))
          .post(
            `${STELLA_API_VERSION_PREFIX}/case/decisions/search`,
            () => "search",
          );
        const response = await app.handle(
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
