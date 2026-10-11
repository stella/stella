import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";

import { STELLA_API_VERSION_PREFIX } from "@stll/api-contract";

import { env } from "@/api/env";
import { API_RATE_LIMITS } from "@/api/lib/limits";
import {
  InMemoryRateLimitContext,
  type RateLimitContext,
  scopedGenerator,
} from "@/api/lib/rate-limit/rate-limit";
import type { createRedisRateLimit } from "@/api/lib/rate-limit/redis-context";
import { resolvePublicCorpusPolicy } from "@/api/public-corpus-policy";

import { createPublicCorpusRateLimitComposition } from "./public-corpus-rate-limit-composition";
import { createPublicCorpusAddressRateLimitOptions } from "./public-corpus-rate-limits";

const searchPath = `${STELLA_API_VERSION_PREFIX}/law/statutes/search`;
const searchKey = scopedGenerator("public-corpus-search");
const isSearchRequest = (request: Request) =>
  resolvePublicCorpusPolicy(request)?.class === "search";
const request = (path: string, method = "GET") =>
  new Request(`http://localhost${path}`, { method });

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
    const { app, searchKeys, sharedKeys, kill } = createBudgetApp();
    env.E2E_DISABLE_AUTH_RATE_LIMIT = true;
    try {
      for (const path of [searchPath, "/v1/other"]) {
        for (let index = 0; index <= 30; index += 1) {
          const response = await app.handle(request(path));
          expect(response.status).toBe(200);
          expect(response.headers.get("RateLimit-Limit")).toBeNull();
        }
      }
      expect(searchKeys).toEqual([]);
      expect(sharedKeys).toEqual([]);
    } finally {
      env.E2E_DISABLE_AUTH_RATE_LIMIT = previous;
      kill();
    }
  });

  test("charges GET and its implicit HEAD search, including the accepted trailing slash", () => {
    for (const path of [
      searchPath,
      `${searchPath}/`,
      `${searchPath}?query=test`,
    ]) {
      expect(isSearchRequest(request(path))).toBe(true);
      expect(isSearchRequest(request(path, "HEAD"))).toBe(true);
    }
    for (const path of [
      "/law/statutes/search",
      "/v1/law/statutes",
      "/v1/law/statutes/read",
      "/v1/law/statutes/search/extra",
      "/v1/legislation/search",
    ]) {
      expect(isSearchRequest(request(path))).toBe(false);
    }
    for (const method of ["POST", "OPTIONS", "PUT", "DELETE"]) {
      expect(isSearchRequest(request(searchPath, method))).toBe(false);
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

  test("the server installs class admission before mounting public routes", async () => {
    const source = await Bun.file(
      new URL("../../server.ts", import.meta.url),
    ).text();
    const imports = new Bun.Transpiler({ loader: "ts" }).scan(source).imports;
    expect(imports.map(({ path }) => path)).toContain(
      "@/api/lib/rate-limit/public-corpus-rate-limit-composition",
    );
    const group = source.slice(
      source.indexOf(".group(STELLA_API_VERSION_PREFIX"),
    );
    expect(
      group.indexOf(".use(publicCorpusRateLimits)"),
    ).toBeGreaterThanOrEqual(0);
    expect(group.indexOf(".use(publicLegislationRoute)")).toBeGreaterThan(
      group.indexOf(".use(publicCorpusRateLimits)"),
    );
    expect(group.indexOf(".use(caseLawRoute)")).toBeGreaterThan(
      group.indexOf(".use(publicCorpusRateLimits)"),
    );
  });

  for (const method of ["GET", "HEAD"]) {
    test(`production composition budgets ${method} searches without consuming the shared quota`, async () => {
      const { app, bindings, searchKeys, sharedKeys, kill } = createBudgetApp();
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
          expect((await app.handle(request(searchPath, method))).status).toBe(
            200,
          );
        }
        const limited = await app.handle(request(`${searchPath}/`, method));
        expect(limited.status).toBe(429);
        if (method === "GET") {
          expect(await limited.text()).toBe("rate-limit reached");
        }
        expect(limited.headers.get("retry-after")).toMatch(/^\d+$/u);
        expect(limited.headers.get("ratelimit-limit")).toBe("30");
        expect(searchKeys).toHaveLength(31);
        expect(new Set(searchKeys)).toEqual(new Set(["public-corpus-search"]));
        expect(sharedKeys).toEqual([]);
        expect((await app.handle(request("/v1/law/statutes"))).status).toBe(
          200,
        );
        expect((await app.handle(request("/v1/other"))).status).toBe(429);
        expect(sharedKeys).toEqual(["api", "api"]);
        expect(searchKeys).toHaveLength(31);
      } finally {
        kill();
      }
    });
  }

  test("exhausting the production shared quota leaves search available", async () => {
    const { app, searchKeys, sharedKeys, kill } = createBudgetApp();
    try {
      expect((await app.handle(request("/v1/law/statutes"))).status).toBe(200);
      expect((await app.handle(request("/v1/law/statutes"))).status).toBe(429);
      expect((await app.handle(request(searchPath))).status).toBe(200);
      expect(sharedKeys).toEqual(["api", "api"]);
      expect(searchKeys).toEqual(["public-corpus-search"]);
    } finally {
      kill();
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
  const app = new Elysia().group(STELLA_API_VERSION_PREFIX, (versioned) =>
    versioned
      .use(composition)
      .get("/law/statutes/search", () => ({ items: [] }))
      .get("/law/statutes", () => "browse")
      .get("/other", () => "ordinary"),
  );
  return {
    app,
    bindings,
    searchKeys,
    sharedKeys,
    kill: () => {
      sharedContext.kill();
      searchContext.kill();
      for (const context of corpusContexts) {
        context.kill();
      }
    },
  };
};
