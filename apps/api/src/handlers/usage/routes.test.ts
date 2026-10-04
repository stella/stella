import { describe, expect, test } from "bun:test";

import { STELLA_API_VERSION_PREFIX } from "@stll/api-contract";

import { env } from "@/api/env";
import { runWithQueryCounter } from "@/api/lib/db-query-counter";
import api from "@/api/server";

const USAGE_PREFIX = `${STELLA_API_VERSION_PREFIX}/usage/`;
const usageRoutes = api.routes.filter(({ path }) =>
  path.startsWith(USAGE_PREFIX),
);

const withUsageFeature = async (enabled: boolean, run: () => Promise<void>) => {
  const previous = env.FEATURE_USAGE;
  env.FEATURE_USAGE = enabled;
  try {
    await run();
  } finally {
    env.FEATURE_USAGE = previous;
  }
};

const requestRoute = (route: (typeof usageRoutes)[number], body = "{}") =>
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
    await withUsageFeature(false, async () => {
      for (const route of usageRoutes) {
        await runWithQueryCounter(async (counter) => {
          const response = await api.handle(requestRoute(route));
          expect({
            method: route.method,
            path: route.path,
            status: response.status,
          }).toEqual({ method: route.method, path: route.path, status: 404 });
          expect(await response.json()).toEqual({ error: "Not Found" });
          expect(counter.count).toBe(0);
        });
      }
    });
  });

  test("every registered usage route retains authentication when enabled", async () => {
    expect(usageRoutes.length).toBeGreaterThan(0);
    await withUsageFeature(true, async () => {
      for (const route of usageRoutes) {
        const response = await api.handle(
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
    const webhookRoutes = api.routes.filter(({ path }) =>
      path.startsWith("/usage/"),
    );
    expect(webhookRoutes.map(({ method, path }) => ({ method, path }))).toEqual(
      [{ method: "POST", path: "/usage/hosted/webhook" }],
    );
    await withUsageFeature(false, async () => {
      for (const route of webhookRoutes) {
        await runWithQueryCounter(async (counter) => {
          const response = await api.handle(requestRoute(route));
          expect(response.status).toBe(503);
          expect(await response.json()).toEqual({
            message: "Hosted usage management not configured",
          });
          expect(counter.count).toBe(0);
        });
      }
    });
  });
});
