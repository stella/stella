import { describe, expect, test } from "bun:test";

import { STELLA_API_VERSION_PREFIX } from "@stll/api-contract";
import { RUNTIME_MODE } from "@stll/runtime-mode";

import { env } from "@/api/env";
import type { RouteEntry } from "@/api/http/route";
import { DB_QUERY_COUNT_HEADER } from "@/api/lib/db-query-counter";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import { apiApp } from "@/api/server";
import { serveForTest } from "@/api/tests/helpers/test-server";

const USAGE_PREFIX = `${STELLA_API_VERSION_PREFIX}/usage/`;
const usageRoutes = apiApp.routes.filter(({ path }) =>
  path.startsWith(USAGE_PREFIX),
);

// Local development serves usage whatever the flag says (the deployment
// feature registry decides that), so the flag is read in a strict runtime.
const withUsageFeature = async (enabled: boolean, run: () => Promise<void>) => {
  const previous = env.FEATURE_USAGE;
  env.FEATURE_USAGE = enabled;
  const restoreRuntimeMode = setRuntimeModeForTesting({
    mode: RUNTIME_MODE.strict,
  });
  try {
    await run();
  } finally {
    restoreRuntimeMode();
    env.FEATURE_USAGE = previous;
  }
};

const requestRoute = (route: RouteEntry, body = "{}") =>
  new Request(`http://localhost${route.path}`, {
    method: route.method,
    // Invalid mutation bodies must be hidden before schema validation too.
    ...(route.method === "GET"
      ? {}
      : { body, headers: { "content-type": "application/json" } }),
  });

describe("usage route feature admission", () => {
  test("every registered usage route is hidden without database access when disabled", async () => {
    expect(usageRoutes.length).toBeGreaterThan(0);
    await using server = serveForTest(apiApp);
    const absent = await server.fetch(
      new Request(`http://localhost${USAGE_PREFIX}no-such-route`),
    );
    expect(absent.status).toBe(404);
    const absentBody: unknown = await absent.json();
    expect(absentBody).toEqual({ message: "Not found" });
    await withUsageFeature(false, async () => {
      for (const route of usageRoutes) {
        const response = await server.fetch(requestRoute(route));
        expect({
          method: route.method,
          path: route.path,
          status: response.status,
        }).toEqual({ method: route.method, path: route.path, status: 404 });
        // Indistinguishable from a route that does not exist.
        expect(await response.json()).toEqual(absentBody);
        // The request's own query count, as the pipeline reports it.
        expect(response.headers.get(DB_QUERY_COUNT_HEADER)).toBe("0");
      }
    });
  });

  test("every registered usage route retains authentication when enabled", async () => {
    expect(usageRoutes.length).toBeGreaterThan(0);
    await using server = serveForTest(apiApp);
    await withUsageFeature(true, async () => {
      for (const route of usageRoutes) {
        const response = await server.fetch(
          requestRoute(
            route,
            JSON.stringify({
              userId: "usage_route_test_user",
              usagePolicyId: "00000000-0000-4000-8000-000000000001",
            }),
          ),
        );
        expect({
          method: route.method,
          path: route.path,
          status: response.status,
        }).toEqual({ method: route.method, path: route.path, status: 401 });
      }
    });
  });

  test("the root provider webhook retains its unavailable delivery response without database access", async () => {
    const webhookRoutes = apiApp.routes.filter(({ path }) =>
      path.startsWith("/usage/"),
    );
    expect(webhookRoutes.map(({ method, path }) => ({ method, path }))).toEqual(
      [{ method: "POST", path: "/usage/hosted/webhook" }],
    );
    await using server = serveForTest(apiApp);
    await withUsageFeature(false, async () => {
      for (const route of webhookRoutes) {
        const response = await server.fetch(requestRoute(route));
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({
          message: "Hosted usage management not configured",
        });
        expect(response.headers.get(DB_QUERY_COUNT_HEADER)).toBe("0");
      }
    });
  });
});
