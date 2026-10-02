import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";

import { STELLA_API_VERSION_PREFIX } from "@stll/api-contract";

import { API_RATE_LIMITS } from "@/api/lib/limits";
import {
  InMemoryRateLimitContext,
  type RateLimitContext,
  scopedGenerator,
} from "@/api/lib/rate-limit/rate-limit";
import type { createRedisRateLimit } from "@/api/lib/rate-limit/redis-context";

import {
  isPublicStatuteSearchRateLimitedRequest,
  PUBLIC_STATUTE_SEARCH_PATH,
  publicStatuteSearchRateLimitKey,
} from "./public-search-rate-limit";
import { createPublicStatuteSearchRateLimitComposition } from "./public-search-rate-limit-composition";

const searchPath = `${STELLA_API_VERSION_PREFIX}${PUBLIC_STATUTE_SEARCH_PATH}`;
const request = (path: string, method = "GET") =>
  new Request(`http://localhost${path}`, { method });

describe("public statute search request budget", () => {
  test("charges GET and its implicit HEAD search, including the accepted trailing slash", () => {
    for (const path of [
      searchPath,
      `${searchPath}/`,
      `${searchPath}?query=test`,
    ]) {
      expect(isPublicStatuteSearchRateLimitedRequest(request(path))).toBe(true);
      expect(
        isPublicStatuteSearchRateLimitedRequest(request(path, "HEAD")),
      ).toBe(true);
    }
    for (const path of [
      PUBLIC_STATUTE_SEARCH_PATH,
      "/v1/law/statutes",
      "/v1/law/statutes/read",
      "/v1/law/statutes/search/extra",
      "/v1/legislation/search",
    ]) {
      expect(isPublicStatuteSearchRateLimitedRequest(request(path))).toBe(
        false,
      );
    }
    for (const method of ["POST", "OPTIONS", "PUT", "DELETE"]) {
      expect(
        isPublicStatuteSearchRateLimitedRequest(request(searchPath, method)),
      ).toBe(false);
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
    const firstKey = await publicStatuteSearchRateLimitKey(
      firstRequest,
      firstPeer,
    );
    expect(
      await publicStatuteSearchRateLimitKey(secondRequest, firstPeer),
    ).toBe(firstKey);
    expect(
      await publicStatuteSearchRateLimitKey(firstRequest, secondPeer),
    ).not.toBe(firstKey);
    expect(firstKey).toBe("public-statute-search:192.0.2.1");
  });

  test("the server installs both halves of the exercised production composition", async () => {
    const source = await Bun.file(
      new URL("../../server.ts", import.meta.url),
    ).text();
    const imports = new Bun.Transpiler({ loader: "ts" }).scan(source).imports;
    expect(imports.map(({ path }) => path)).toContain(
      "@/api/handlers/legislation/public-search-rate-limit-composition",
    );
    expect(
      /const publicStatuteSearchRateLimits\s*=\s*createPublicStatuteSearchRateLimitComposition\(\{\s*routes: publicLegislationRoute,/u.test(
        source,
      ),
    ).toBe(true);
    const group = source.slice(
      source.indexOf(".group(STELLA_API_VERSION_PREFIX"),
    );
    expect(group.includes(".use(publicStatuteSearchRateLimits.shared)")).toBe(
      true,
    );
    expect(
      group.includes(".use(publicStatuteSearchRateLimits.publicLegislation)"),
    ).toBe(true);
    expect(/\.use\(\s*publicLegislationRoute\s*\)/u.test(source)).toBe(false);
  });

  for (const method of ["GET", "HEAD"]) {
    test(`production composition budgets ${method} searches without consuming the shared quota`, async () => {
      const { app, bindings, searchKeys, sharedKeys, kill } = createBudgetApp();
      try {
        expect(
          bindings.map(({ scope, failurePolicy }) => ({
            scope,
            failurePolicy,
          })),
        ).toEqual([
          { scope: "api", failurePolicy: "fail_open_local" },
          { scope: "public-statute-search", failurePolicy: "fail_open_local" },
        ]);
        for (
          let index = 0;
          index < API_RATE_LIMITS.publicStatuteSearch.max;
          index += 1
        ) {
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
        expect(limited.headers.get("ratelimit-limit")).toBe(
          String(API_RATE_LIMITS.publicStatuteSearch.max),
        );
        expect(searchKeys).toHaveLength(
          API_RATE_LIMITS.publicStatuteSearch.max + 1,
        );
        expect(new Set(searchKeys)).toEqual(new Set(["public-statute-search"]));
        expect(sharedKeys).toEqual([]);
        expect((await app.handle(request("/v1/law/statutes"))).status).toBe(
          200,
        );
        expect((await app.handle(request("/v1/other"))).status).toBe(429);
        expect(sharedKeys).toEqual(["api", "api"]);
        expect(searchKeys).toHaveLength(
          API_RATE_LIMITS.publicStatuteSearch.max + 1,
        );
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
      expect(searchKeys).toEqual(["public-statute-search"]);
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
  // One observed shared request fills its quota, so independence is checked
  // without issuing hundreds of unrelated requests per test.
  const sharedCounter: RateLimitContext = {
    init: (options) => sharedContext.init(options),
    increment: (key, duration, requestTime) => {
      sharedKeys.push(key);
      const counter = sharedContext.increment(key, duration, requestTime);
      return { ...counter, count: counter.count * API_RATE_LIMITS.api.max };
    },
    decrement: (key) => sharedContext.decrement(key),
    kill: () => sharedContext.kill(),
  };
  const searchCounter: RateLimitContext = {
    init: (options) => searchContext.init(options),
    increment: (key, duration, requestTime) => {
      searchKeys.push(key);
      return searchContext.increment(key, duration, requestTime);
    },
    decrement: (key) => searchContext.decrement(key),
    kill: () => searchContext.kill(),
  };
  const composition = createPublicStatuteSearchRateLimitComposition({
    routes: new Elysia()
      .get(PUBLIC_STATUTE_SEARCH_PATH, () => ({ items: [] }))
      .get("/law/statutes", () => "browse"),
    createRedisBinding: (options) => {
      bindings.push(options);
      expect(["api", "public-statute-search"]).toContain(options.scope);
      return {
        context: options.scope === "api" ? sharedCounter : searchCounter,
        generator:
          options.counterKeyGenerator ?? scopedGenerator(options.scope),
      };
    },
  });
  const app = new Elysia().group(STELLA_API_VERSION_PREFIX, (versioned) =>
    versioned
      .use(composition.shared)
      .use(composition.publicLegislation)
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
    },
  };
};
