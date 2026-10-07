import { describe, expect, test } from "bun:test";

import {
  markAiRequest,
  runWithRequestIdScope,
} from "@/api/lib/observability/request-context";
import {
  requestClassAtCompletion,
  ROUTE_LATENCY_CLASSES,
} from "@/api/lib/observability/route-latency-class";
import api from "@/api/server";

const SEARCH_SHAPED_PATH =
  /\/(?:search|sitemap|citing-decisions|citation-counts|citations\/(?:summary|leading))(?:\/|$)/u;

/**
 * Search-shaped routes deliberately left undeclared, so they complete as
 * `ai` (a model call marks them at runtime) or `crud`.
 */
const UNDECLARED_SEARCH_SHAPED_ROUTES = {
  "POST /v1/case/decisions/search/refine":
    "Calls a model, so it completes as ai.",
  "POST /v1/case/decisions/search/expand":
    "Calls a model, so it completes as ai.",
  "POST /v1/search/refine": "Calls a model, so it completes as ai.",
  "POST /v1/search/summary": "Calls a model, so it completes as ai.",
  "GET /v1/contacts/search":
    "A name picker over one organization's contacts, capped at 20 rows.",
  "POST /v1/search/":
    "Interactive search over the caller's own matters; held to the crud SLO.",
  "POST /v1/search/facets":
    "Facet counts for the interactive matter search; held to the crud SLO.",
  "POST /v1/search/preview":
    "Hit preview for the interactive matter search; held to the crud SLO.",
  "POST /v1/search/summary/chat":
    "Saves an already generated summary as a chat thread; no model call.",
} as const satisfies Record<string, string>;

type RegisteredRoute = { method: string; path: string };

type RouteClassCensusInput = {
  routes: readonly RegisteredRoute[];
  declared: Readonly<Record<string, string>>;
  undeclared: Readonly<Record<string, string>>;
};

type RouteClassCensus = {
  /** Declared keys no registered route answers to. */
  staleDeclared: string[];
  /** Exclusion keys no registered route answers to. */
  staleUndeclared: string[];
  /** Search-shaped routes neither declared nor excluded. */
  unclassified: string[];
};

const routeClassCensus = ({
  routes,
  declared,
  undeclared,
}: RouteClassCensusInput): RouteClassCensus => {
  const registered = new Set(
    routes.map(({ method, path }) => `${method} ${path}`),
  );
  const unclassified: string[] = [];
  for (const key of registered) {
    if (!SEARCH_SHAPED_PATH.test(key.slice(key.indexOf(" ") + 1))) {
      continue;
    }
    if (Object.hasOwn(declared, key) || Object.hasOwn(undeclared, key)) {
      continue;
    }
    unclassified.push(key);
  }
  return {
    staleDeclared: Object.keys(declared).filter((key) => !registered.has(key)),
    staleUndeclared: Object.keys(undeclared).filter(
      (key) => !registered.has(key),
    ),
    unclassified,
  };
};

const EMPTY_CENSUS = {
  staleDeclared: [],
  staleUndeclared: [],
  unclassified: [],
} as const satisfies RouteClassCensus;

describe("the route latency class census", () => {
  test("binds every declaration to a registered route and every search-shaped route to a decision", () => {
    // The census reaches the real route table and the search-shaped routes
    // in it, so a green run is not vacuous.
    expect(api.routes.length).toBeGreaterThan(100);
    expect(
      api.routes.some(({ path }) => SEARCH_SHAPED_PATH.test(path)),
    ).toBeTrue();

    expect(
      routeClassCensus({
        routes: api.routes,
        declared: ROUTE_LATENCY_CLASSES,
        undeclared: UNDECLARED_SEARCH_SHAPED_ROUTES,
      }),
    ).toEqual(EMPTY_CENSUS);
  });

  test("reports an unclassified search-shaped route, and stale keys on both lists", () => {
    expect(
      routeClassCensus({
        routes: [
          { method: "GET", path: "/v1/widgets/search" },
          { method: "GET", path: "/v1/widgets/:widgetId/citations/leading" },
          { method: "GET", path: "/v1/widgets/sitemap/shards" },
          { method: "GET", path: "/v1/widgets/search-history" },
          { method: "GET", path: "/v1/widgets/declared/search" },
          { method: "GET", path: "/v1/widgets/excluded/search" },
        ],
        declared: {
          "GET /v1/widgets/declared/search": "search",
          "GET /v1/widgets/renamed/search": "search",
        },
        undeclared: {
          "GET /v1/widgets/excluded/search": "Cheap.",
          "GET /v1/widgets/removed/search": "Cheap.",
        },
      }),
    ).toEqual({
      staleDeclared: ["GET /v1/widgets/renamed/search"],
      staleUndeclared: ["GET /v1/widgets/removed/search"],
      unclassified: [
        "GET /v1/widgets/search",
        "GET /v1/widgets/:widgetId/citations/leading",
        "GET /v1/widgets/sitemap/shards",
      ],
    });
  });
});

describe("the class a completed request is measured under", () => {
  const search = {
    method: "POST",
    route: "/v1/case/decisions/search",
  } as const;
  const batch = { method: "GET", route: "/v1/case/sitemap/shards" } as const;

  test("is the route's declared class", () => {
    runWithRequestIdScope(() => {
      expect(requestClassAtCompletion(search)).toBe("search");
      expect(requestClassAtCompletion(batch)).toBe("batch");
    });
  });

  test("is ai once the request reached a model, whatever the route declares", () => {
    for (const route of [search, batch]) {
      runWithRequestIdScope(() => {
        markAiRequest();
        expect(requestClassAtCompletion(route)).toBe("ai");
      });
    }
  });

  test("is crud for an undeclared route, an unmatched request, or another method", () => {
    runWithRequestIdScope(() => {
      expect(
        requestClassAtCompletion({ method: "GET", route: "/v1/contacts" }),
      ).toBe("crud");
      expect(
        requestClassAtCompletion({ method: "GET", route: "unmatched" }),
      ).toBe("crud");
      expect(requestClassAtCompletion({ ...search, method: "GET" })).toBe(
        "crud",
      );
    });
  });
});
