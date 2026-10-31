import { describe, expect, test } from "bun:test";

import { STELLA_API_VERSION_PREFIX } from "@stll/api-contract";

import { apiRoutes } from "@/api/api-routes";
import { PUBLIC_READ_STATEMENT_TIMEOUT_MS } from "@/api/db/shared-pool-timeouts";
import { publicCaseLawRoute } from "@/api/handlers/case-law/public-routes";
import { publicLegislationRoute } from "@/api/handlers/legislation/public-routes";
import { mount, routes } from "@/api/http/route";
import type { RouteDefinition, RouteEntry } from "@/api/http/route";
import { PublicLawStatementError } from "@/api/lib/legal-search/public-law-statement-error";
import {
  PUBLIC_READ_TIMEOUT_CODE,
  publicReadTimeoutError,
  runPublicReadRequest,
} from "@/api/lib/legal-search/public-read-timeout";
import { getPublicReadStatementTimeoutMs } from "@/api/lib/legal-search/public-read-timeout-context";
import { PG_ERROR } from "@/api/lib/pg-error";
import {
  PUBLIC_CORPUS_ROUTE_POLICY,
  publicCorpusClassOf,
} from "@/api/public-corpus-policy";

const routeLabel = ({ method, path }: { method: string; path: string }) =>
  `${method} ${path}`;

const routeLabels = (entries: readonly RouteEntry[]): string[] =>
  entries.map(routeLabel).toSorted();

const versioned = (path: string) => `${STELLA_API_VERSION_PREFIX}${path}`;

/** A policy key as the mounted route it names, version prefix included. */
const mountedRouteOf = (key: string) => {
  const separator = key.indexOf(" ");
  return {
    method: key.slice(0, separator),
    path: versioned(key.slice(separator + 1)),
  };
};

/**
 * Every route the two public corpus tables contribute to the served table.
 * A route table is plain data, so no registration can sit outside what this
 * sees; the served entries are matched by definition identity, so a corpus
 * route the API mounted somewhere unexpected still counts, at its real path.
 */
const servedCorpusRoutes = (): RouteEntry[] => {
  const corpusDefinitions = new Set<RouteDefinition>(
    [...publicLegislationRoute, ...publicCaseLawRoute].map(
      ({ definition }) => definition,
    ),
  );
  return apiRoutes.filter(({ definition }) =>
    corpusDefinitions.has(definition),
  );
};

const fixture: RouteDefinition = {
  access: "public",
  config: {},
  run: async () => "ok",
};

type CensusOptions = {
  mounted: readonly string[];
  classified: readonly string[];
};

const expectCompletePolicy = ({ mounted, classified }: CensusOptions) => {
  expect(
    [...classified].toSorted(),
    "Every mounted route must have exactly one policy; removed routes must leave no stale policy",
  ).toEqual([...mounted].toSorted());
};

describe("public corpus admission policy", () => {
  test("request budgets survive asynchronous reads without leaking into other work", async () => {
    const request = new Request(
      `http://localhost${versioned("/law/statutes")}`,
    );
    const reached = Promise.withResolvers<undefined>();
    const resume = Promise.withResolvers<undefined>();
    const reading = runPublicReadRequest(
      { request, route: versioned("/law/statutes") },
      async () => {
        reached.resolve(undefined);
        await resume.promise;
        return getPublicReadStatementTimeoutMs();
      },
    );
    await reached.promise;
    expect(getPublicReadStatementTimeoutMs()).toBeUndefined();
    resume.resolve(undefined);
    expect(await reading).toBe(PUBLIC_READ_STATEMENT_TIMEOUT_MS.browse);
    expect(getPublicReadStatementTimeoutMs()).toBeUndefined();
  });

  test("only public request cancellations become typed retryable statuses", () => {
    const canceled = Object.assign(new Error("SQL diagnostics"), {
      code: PG_ERROR.QUERY_CANCELED,
    });
    const observed = new PublicLawStatementError({
      message: "Public-law statement failed",
      cause: canceled,
    });
    expect(publicReadTimeoutError(canceled)).toBeNull();
    expect(publicReadTimeoutError(observed)).toBeNull();
    const request = new Request(
      `http://localhost${versioned("/law/statutes/search")}`,
    );
    runPublicReadRequest(
      { request, route: versioned("/law/statutes/search") },
      () => {
        expect(publicReadTimeoutError(canceled)).toBeNull();
        const wrapped = new Error("query wrapper", { cause: canceled });
        expect(publicReadTimeoutError(wrapped)).toBeNull();
        const observedWrapped = new Error("query wrapper", {
          cause: observed,
        });
        expect(publicReadTimeoutError(observedWrapped)).toMatchObject({
          status: 503,
          code: PUBLIC_READ_TIMEOUT_CODE,
          message: "Public read timed out. Please try again.",
        });
        expect(publicReadTimeoutError(new Error("other failure"))).toBeNull();
      },
    );
  });

  test("every public corpus route the API serves has exactly one policy, and no policy is stale", () => {
    const served = servedCorpusRoutes();
    // Both tables, every route: a census that matched nothing would pass.
    expect(served.length).toBe(
      publicLegislationRoute.length + publicCaseLawRoute.length,
    );
    // Served under the version prefix, where the policy reads them.
    expect(
      served
        .filter(({ path }) => !path.startsWith(`${STELLA_API_VERSION_PREFIX}/`))
        .map(routeLabel),
    ).toEqual([]);
    expectCompletePolicy({
      mounted: served.map(routeLabel),
      classified: Object.keys(PUBLIC_CORPUS_ROUTE_POLICY).map((key) =>
        routeLabel(mountedRouteOf(key)),
      ),
    });
    for (const entry of served) {
      expect(publicCorpusClassOf(entry), routeLabel(entry)).toBeDefined();
    }
  });

  test("every policy key names a route the API serves", () => {
    const served = new Set(routeLabels(apiRoutes));
    expect(
      Object.keys(PUBLIC_CORPUS_ROUTE_POLICY).filter(
        (key) => !served.has(routeLabel(mountedRouteOf(key))),
      ),
    ).toEqual([]);
  });

  test("each policy class sets its statement budget for the request", () => {
    for (const [key, routeClass] of Object.entries(
      PUBLIC_CORPUS_ROUTE_POLICY,
    )) {
      const route = mountedRouteOf(key);
      const request = new Request(
        `http://localhost${route.path.replace(/:[^/]+/gu, "fixture")}`,
        { method: route.method },
      );
      const budget = runPublicReadRequest(
        { request, route: route.path },
        getPublicReadStatementTimeoutMs,
      );
      expect(budget, key).toBe(PUBLIC_READ_STATEMENT_TIMEOUT_MS[routeClass]);
      expect(budget, key).toBeGreaterThan(0);
    }
    expect(getPublicReadStatementTimeoutMs()).toBeUndefined();
  });

  test("the census rejects an unclassified route and a stale removed route", () => {
    const initial = routes(
      { "/statutes": { GET: fixture } },
      { prefix: "/law" },
    );
    const added = routes(
      {
        "/statutes": { GET: fixture },
        "/new-expensive-route": { POST: fixture },
      },
      { prefix: "/law" },
    );
    const classified = routeLabels(initial);
    const newRoutes = routeLabels(added);
    const removedRoutes = routeLabels(routes({}, { prefix: "/law" }));
    expect(classified).toEqual(["GET /law/statutes"]);
    expect(newRoutes).toContain("POST /law/new-expensive-route");
    expect(removedRoutes).toEqual([]);
    expect(() =>
      expectCompletePolicy({ mounted: newRoutes, classified }),
    ).toThrow("Every mounted route");
    expect(() =>
      expectCompletePolicy({ mounted: removedRoutes, classified }),
    ).toThrow("Every mounted route");
  });

  test("composed tables enumerate nested routes and keep exact policy coverage", () => {
    const nested = routes(
      { "/resolve": { POST: fixture } },
      { prefix: "/extra" },
    );
    const composed = mount(
      [routes({ "/statutes": { GET: fixture } }), nested],
      { prefix: "/law" },
    );
    const mounted = routeLabels(composed);
    expect(mounted).toEqual(["GET /law/statutes", "POST /law/extra/resolve"]);
    const classified = ["GET /law/statutes"];
    expect(() => expectCompletePolicy({ mounted, classified })).toThrow(
      "Every mounted route",
    );
    const removed = routeLabels(
      mount([routes({ "/statutes": { GET: fixture } })], { prefix: "/law" }),
    );
    expect(removed).toEqual(classified);
    expect(() =>
      expectCompletePolicy({ mounted: removed, classified: mounted }),
    ).toThrow("Every mounted route");
  });

  test("search and aggregate endpoints use their expensive admission classes", () => {
    const expected = {
      "GET /law/statutes/search": "search",
      "POST /case/decisions/search": "search",
      "GET /case/decisions": "browse",
      "GET /law/statutes/facets": "aggregate",
      "GET /case/decisions/facets": "aggregate",
      "GET /case/provisions/citation-counts": "aggregate",
      "GET /case/provisions/citing-decisions": "aggregate",
      "POST /law/statutes/resolve": "aggregate",
      "GET /law/statutes/:documentId": "browse",
      "GET /case/decisions/:decisionId": "browse",
      "GET /law/sitemap/shards": "sitemap",
      "GET /law/sitemap/statutes/shard": "sitemap",
      "GET /case/sitemap/shards": "sitemap",
      "GET /case/sitemap/decisions/shard": "sitemap",
    } as const;
    for (const [key, admissionClass] of Object.entries(expected)) {
      expect(publicCorpusClassOf(mountedRouteOf(key)), key).toBe(
        admissionClass,
      );
    }
  });

  test("a HEAD request reads its GET route's class", () => {
    for (const [key, admissionClass] of Object.entries(
      PUBLIC_CORPUS_ROUTE_POLICY,
    )) {
      const route = mountedRouteOf(key);
      if (route.method !== "GET") {
        continue;
      }
      expect(publicCorpusClassOf({ ...route, method: "HEAD" }), key).toBe(
        admissionClass,
      );
    }
  });

  test("a literal segment never falls into the class of an identifier route", () => {
    // `facets` is an aggregate while `:decisionId` is a browse: the class is
    // read off the pattern the router matched, never off a concrete path that
    // an identifier pattern would also match.
    expect(
      publicCorpusClassOf(mountedRouteOf("GET /case/decisions/facets")),
    ).toBe("aggregate");
    expect(
      publicCorpusClassOf(mountedRouteOf("GET /law/statutes/facets")),
    ).toBe("aggregate");
    expect(
      publicCorpusClassOf(mountedRouteOf("GET /case/decisions/:decisionId")),
    ).toBe("browse");
    expect(
      publicCorpusClassOf(mountedRouteOf("GET /law/statutes/:documentId")),
    ).toBe("browse");
    for (const key of [
      "GET /law/statutes/facets",
      "GET /law/statutes/search",
      "GET /law/statutes/by-eli",
      "GET /case/decisions/facets",
      "GET /case/decisions/status",
      "GET /case/decisions/latest",
    ] as const) {
      expect(publicCorpusClassOf(mountedRouteOf(key)), key).toBe(
        PUBLIC_CORPUS_ROUTE_POLICY[key],
      );
    }
    // A concrete path is not a pattern: it names no route of the table.
    expect(
      publicCorpusClassOf({
        method: "GET",
        path: versioned("/case/decisions/0190f2c4-0000-7000-8000-000000000001"),
      }),
    ).toBeUndefined();
  });

  test("unrelated routes, unsupported methods and unversioned paths remain outside admission", () => {
    for (const route of [
      { method: "POST", path: versioned("/law/statutes/search") },
      { method: "GET", path: versioned("/case/decisions/:decisionId/extra") },
      { method: "GET", path: versioned("/lawyers/statutes") },
      { method: "GET", path: "/health" },
      // The policy is keyed under the version prefix only.
      { method: "GET", path: "/case/decisions" },
      undefined,
    ]) {
      expect(publicCorpusClassOf(route)).toBeUndefined();
    }
  });
});
