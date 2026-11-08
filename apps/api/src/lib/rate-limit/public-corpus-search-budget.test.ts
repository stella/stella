import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { STELLA_API_VERSION_PREFIX } from "@stll/api-contract";

import { apiRoutes } from "@/api/api-routes";
import { env } from "@/api/env";
import { createHttpApp } from "@/api/http/app";
import { mount, routes } from "@/api/http/route";
import { defineEndpoint } from "@/api/lib/endpoints";
import { API_RATE_LIMITS } from "@/api/lib/limits";
import { errorBoundary } from "@/api/lib/observability/request-lifecycle";
import type { RateLimitContext } from "@/api/lib/rate-limit/contracts";
import {
  InMemoryRateLimitContext,
  isRateLimitMiddleware,
  scopedGenerator,
} from "@/api/lib/rate-limit/rate-limit";
import type { createRedisRateLimit } from "@/api/lib/rate-limit/redis-context";
import {
  PUBLIC_CORPUS_ROUTE_POLICY,
  publicCorpusClassOf,
} from "@/api/public-corpus-policy";
import { serveForTest } from "@/api/tests/helpers/test-server";

import { createPublicCorpusRateLimitComposition } from "./public-corpus-rate-limit-composition";
import { createPublicCorpusAddressRateLimitOptions } from "./public-corpus-rate-limits";

const searchPath = `${STELLA_API_VERSION_PREFIX}/law/statutes/search`;
const searchKey = scopedGenerator("public-corpus-search");
/** Whether the route mounted at `path` for `method` spends the search class. */
const isSearchRoute = (method: string, path: string) =>
  publicCorpusClassOf({ method, path }, new URL(`http://localhost${path}`)) ===
  "search";
const request = (path: string, method = "GET") =>
  new Request(`http://localhost${path}`, { method });
/**
 * The test client reaches the server over loopback, so every counter is keyed
 * by that peer: `127.0.0.1`, or `::1` normalized to its /64 network (`::`).
 */
const LOOPBACK_RATE_LIMIT_ADDRESSES: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "::",
]);
/** The peer address the first recorded `scope` key names, checked as loopback. */
const loopbackAddressOf = (scope: string, keys: readonly string[]): string => {
  const prefix = `${scope}:`;
  const key = keys.at(0);
  if (key?.startsWith(prefix) !== true) {
    return panic(
      `The ${scope} budget must key its counter by the peer address`,
    );
  }
  const address = key.slice(prefix.length);
  expect(LOOPBACK_RATE_LIMIT_ADDRESSES.has(address)).toBe(true);
  return address;
};

describe("public corpus search request budget", () => {
  test("public search counter scopes belong only to the class policy helper", async () => {
    const sourceRoot = new URL("../../", import.meta.url).pathname;
    const violations: string[] = [];
    for await (const path of new Bun.Glob("**/*.ts").scan(sourceRoot)) {
      if (
        path.endsWith(".test.ts") ||
        path === "lib/rate-limit/public-corpus-rate-limits.ts"
      ) {
        continue;
      }
      const source = await Bun.file(`${sourceRoot}${path}`).text();
      if (/["'`]public[-\w]*search(?::[^"'`]*)?["'`]/u.test(source)) {
        violations.push(path);
      }
    }
    expect(violations).toEqual([]);
  });
  test("the shared development bypass skips class and ordinary HTTP budgets", async () => {
    const previous = env.E2E_DISABLE_AUTH_RATE_LIMIT;
    const { server, searchKeys, sharedKeys, kill } = createBudgetApp();
    env.E2E_DISABLE_AUTH_RATE_LIMIT = true;
    try {
      for (const path of [searchPath, "/v1/other"]) {
        for (let index = 0; index <= 30; index += 1) {
          const response = await server.fetch(request(path));
          expect(response.status).toBe(200);
          expect(response.headers.get("RateLimit-Limit")).toBeNull();
        }
      }
      expect(searchKeys).toEqual([]);
      expect(sharedKeys).toEqual([]);
    } finally {
      env.E2E_DISABLE_AUTH_RATE_LIMIT = previous;
      await kill();
    }
  });

  test("classes the mounted search route for GET and its implicit HEAD only", () => {
    expect(isSearchRoute("GET", searchPath)).toBe(true);
    expect(isSearchRoute("HEAD", searchPath)).toBe(true);
    for (const path of [
      "/law/statutes/search",
      "/v1/law/statutes",
      "/v1/law/statutes/:documentId",
      "/v1/law/statutes/search/extra",
      "/v1/legislation/search",
    ]) {
      expect(isSearchRoute("GET", path)).toBe(false);
    }
    for (const method of ["POST", "OPTIONS", "PUT", "DELETE"]) {
      expect(isSearchRoute(method, searchPath)).toBe(false);
    }
  });

  test("charges GET and its implicit HEAD search, including the accepted trailing slash", async () => {
    const { server, searchKeys, sharedKeys, kill } = createBudgetApp();
    try {
      let charged = 0;
      for (const path of [
        searchPath,
        `${searchPath}/`,
        `${searchPath}?query=test`,
      ]) {
        for (const method of ["GET", "HEAD"]) {
          expect((await server.fetch(request(path, method))).status).toBe(200);
          charged += 1;
          expect(searchKeys).toHaveLength(charged);
        }
      }
      expect(sharedKeys).toEqual([]);
    } finally {
      await kill();
    }
  });

  test("keys the search budget by the trusted client address, independent of credentials", async () => {
    const firstRequest = request(searchPath);
    const secondRequest = new Request(firstRequest, {
      headers: {
        authorization: "Bearer a-different-credential",
        "x-forwarded-for": "198.51.100.10",
      },
    });
    const firstPeer = { requestIP: () => ({ address: "192.0.2.1" }) };
    const secondPeer = { requestIP: () => ({ address: "192.0.2.2" }) };
    const firstKey = await searchKey(firstRequest, firstPeer);
    expect(await searchKey(secondRequest, firstPeer)).toBe(firstKey);
    expect(await searchKey(firstRequest, secondPeer)).not.toBe(firstKey);
    expect(firstKey).toBe("public-corpus-search:192.0.2.1");
  });

  test("configures a shared 30-request, 60,000 ms search budget", () => {
    const context = new InMemoryRateLimitContext();
    try {
      const options = createPublicCorpusAddressRateLimitOptions(
        "search",
        () => ({
          context,
          generator: searchKey,
        }),
      );
      expect(options.max).toBe(30);
      expect(options.duration).toBe(60_000);
    } finally {
      context.kill();
    }
  });

  test("every classified public corpus route carries the one class admission composition", () => {
    const classified = Object.keys(PUBLIC_CORPUS_ROUTE_POLICY).map((id) => {
      const separator = id.indexOf(" ");
      return {
        id,
        method: id.slice(0, separator),
        path: `${STELLA_API_VERSION_PREFIX}${id.slice(separator + 1)}`,
      };
    });
    const mounted = classified.map(({ id, method, path }) => ({
      id,
      entry: apiRoutes.find(
        (entry) => entry.method === method && entry.path === path,
      ),
    }));
    expect(
      mounted.filter(({ entry }) => entry === undefined).map(({ id }) => id),
    ).toEqual([]);
    const limiters = mounted.flatMap(({ id, entry }) =>
      entry === undefined
        ? []
        : [{ id, stages: entry.middleware.filter(isRateLimitMiddleware) }],
    );
    const reference = limiters.at(0);
    if (reference === undefined) {
      panic("No classified public corpus route is mounted");
    }
    // The shared budget, three class address budgets and three global ones.
    expect(reference.stages.length).toBeGreaterThanOrEqual(7);
    // One composition instance: every class route spends the same buckets.
    expect(
      limiters
        .filter(
          ({ stages }) =>
            stages.length !== reference.stages.length ||
            stages.some((stage, index) => stage !== reference.stages[index]),
        )
        .map(({ id }) => id),
    ).toEqual([]);
  });

  for (const method of ["GET", "HEAD"]) {
    test(`production composition budgets ${method} searches without consuming the shared quota`, async () => {
      const { server, bindings, searchKeys, sharedKeys, kill } =
        createBudgetApp();
      try {
        expect(
          bindings
            .map(({ scope, failurePolicy }) => ({
              scope,
              failurePolicy,
            }))
            .toSorted(
              (left, right) =>
                Number(left.scope > right.scope) -
                Number(left.scope < right.scope),
            ),
        ).toEqual(
          (
            [
              { scope: "api", failurePolicy: "fail_open_local" },
              {
                scope: "public-corpus-search",
                failurePolicy: "fail_open_local",
              },
              {
                scope: "public-corpus-aggregate",
                failurePolicy: "fail_open_local",
              },
              {
                scope: "public-corpus-sitemap",
                failurePolicy: "fail_open_local",
              },
              {
                scope: "public-corpus-global-search",
                failurePolicy: "fail_open_local",
              },
              {
                scope: "public-corpus-global-aggregate",
                failurePolicy: "fail_open_local",
              },
              {
                scope: "public-corpus-global-sitemap",
                failurePolicy: "fail_open_local",
              },
            ] as const
          ).toSorted(
            (left, right) =>
              Number(left.scope > right.scope) -
              Number(left.scope < right.scope),
          ),
        );
        for (let index = 0; index < 30; index += 1) {
          expect((await server.fetch(request(searchPath, method))).status).toBe(
            200,
          );
        }
        const limited = await server.fetch(request(`${searchPath}/`, method));
        expect(limited.status).toBe(429);
        if (method === "GET") {
          expect(await limited.text()).toBe("rate-limit reached");
        }
        expect(limited.headers.get("retry-after")).toMatch(/^\d+$/u);
        expect(limited.headers.get("ratelimit-limit")).toBe("30");
        expect(searchKeys).toHaveLength(31);
        const address = loopbackAddressOf("public-corpus-search", searchKeys);
        expect(new Set(searchKeys)).toEqual(
          new Set([`public-corpus-search:${address}`]),
        );
        expect(sharedKeys).toEqual([]);
        expect((await server.fetch(request("/v1/law/statutes"))).status).toBe(
          200,
        );
        expect((await server.fetch(request("/v1/other"))).status).toBe(429);
        expect(sharedKeys).toEqual([`api:${address}`, `api:${address}`]);
        expect(searchKeys).toHaveLength(31);
      } finally {
        await kill();
      }
    });
  }

  test("exhausting the production shared quota leaves search available", async () => {
    const { server, searchKeys, sharedKeys, kill } = createBudgetApp();
    try {
      expect((await server.fetch(request("/v1/law/statutes"))).status).toBe(
        200,
      );
      expect((await server.fetch(request("/v1/law/statutes"))).status).toBe(
        429,
      );
      expect((await server.fetch(request(searchPath))).status).toBe(200);
      const address = loopbackAddressOf("api", sharedKeys);
      expect(sharedKeys).toEqual([`api:${address}`, `api:${address}`]);
      expect(searchKeys).toEqual([`public-corpus-search:${address}`]);
    } finally {
      await kill();
    }
  });
});

const createBudgetApp = () => {
  const bindings: Parameters<typeof createRedisRateLimit>[0][] = [];
  const sharedKeys: string[] = [];
  const searchKeys: string[] = [];
  const sharedContext = new InMemoryRateLimitContext();
  const searchContext = new InMemoryRateLimitContext();
  const corpusContexts: InMemoryRateLimitContext[] = [];
  // One observed shared request fills its quota, so independence is checked
  // without issuing hundreds of unrelated requests per test.
  const sharedCounter: RateLimitContext = {
    init: (options) => sharedContext.init(options),
    increment: (key, duration, requestTime) => {
      sharedKeys.push(key);
      const counter = sharedContext.increment(key, duration, requestTime);
      return { ...counter, count: counter.count * API_RATE_LIMITS.api.max };
    },
    complete: (key) => sharedContext.complete(key),
    decrement: (key) => sharedContext.decrement(key),
    kill: () => sharedContext.kill(),
  };
  const searchCounter: RateLimitContext = {
    init: (options) => searchContext.init(options),
    increment: (key, duration, requestTime) => {
      searchKeys.push(key);
      return searchContext.increment(key, duration, requestTime);
    },
    complete: (key) => searchContext.complete(key),
    decrement: (key) => searchContext.decrement(key),
    kill: () => searchContext.kill(),
  };
  const composition = createPublicCorpusRateLimitComposition({
    createRedisBinding: (options) => {
      bindings.push(options);
      const context = (() => {
        if (options.scope === "api") {
          return sharedCounter;
        }
        if (options.scope === "public-corpus-search") {
          return searchCounter;
        }
        return new InMemoryRateLimitContext();
      })();
      if (context instanceof InMemoryRateLimitContext) {
        corpusContexts.push(context);
      }
      return {
        context,
        generator:
          options.counterKeyGenerator ?? scopedGenerator(options.scope),
      };
    },
  });
  const server = serveForTest(
    createHttpApp({
      middleware: [errorBoundary],
      routes: mount(
        [
          routes({
            "/law/statutes/search": {
              GET: defineEndpoint.public({}, () => ({ items: [] })),
            },
            "/law/statutes": { GET: defineEndpoint.public({}, () => "browse") },
            "/other": { GET: defineEndpoint.public({}, () => "ordinary") },
          }),
        ],
        { prefix: STELLA_API_VERSION_PREFIX, middleware: composition },
      ),
    }),
  );
  return {
    server,
    bindings,
    searchKeys,
    sharedKeys,
    kill: async () => {
      await server.stop();
      sharedContext.kill();
      searchContext.kill();
      for (const context of corpusContexts) {
        context.kill();
      }
    },
  };
};
