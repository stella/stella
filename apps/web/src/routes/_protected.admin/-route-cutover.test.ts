import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { createMemoryHistory, createRouter } from "@tanstack/react-router";
import { plugin } from "bun";
import { afterAll, expect, test } from "bun:test";
import { readdirSync } from "node:fs";

import { createAnalyticsValue } from "@/lib/analytics/provider";
import { createRouteErrorLifecycleController } from "@/lib/analytics/route-error-lifecycle";
import { createAppQueryClient } from "@/lib/react-query";
import { parseRouteSearch, stringifyRouteSearch } from "@/route-search-params";
import { WEB_ROUTE_TEMPLATES } from "@/route-templates.gen";
import { organizationSettingsDestination } from "@/routes/_protected.admin/-route-cutover";
import { unregisterDomEnvironment } from "@/test-dom-environment";

const EMPTY_SEARCH = {};

GlobalRegistrator.register({ url: "http://localhost:3000" });
afterAll(async () => await unregisterDomEnvironment());

plugin({
  name: "worker-url",
  setup(build) {
    build.onLoad({ filter: /\?worker&url$/u }, () => ({
      contents: 'export default "/worker.js";',
      loader: "js",
    }));
  },
});

const { routeTree } = await import("@/routeTree.gen");

test("the organization and legacy roots resolve to General", () => {
  for (const pathname of [
    "/settings/organization",
    "/settings/organization/",
    "/admin",
    "/admin/",
  ]) {
    expect(organizationSettingsDestination(pathname, EMPTY_SEARCH)).toEqual({
      to: "/settings/organization/general",
      search: EMPTY_SEARCH,
    });
  }
});

test("every legacy admin route preserves its section in Settings", () => {
  const sections = readdirSync(import.meta.dir)
    .filter((name) => name.endsWith(".tsx") && name !== "route.tsx")
    .map((name) => name.replace(/\.tsx$/u, ""))
    .filter((name) => name !== "index");
  expect(sections.length).toBeGreaterThan(0);
  for (const section of sections) {
    expect(
      organizationSettingsDestination(`/admin/${section}`, EMPTY_SEARCH),
    ).toEqual({
      to: `/settings/organization/${section}`,
      search: EMPTY_SEARCH,
    });
  }
});

test("legacy member search is forwarded with its matching section", () => {
  expect(
    organizationSettingsDestination("/admin/members", { q: "alice" }),
  ).toEqual({
    to: "/settings/organization/members",
    search: { q: "alice" },
  });
});

test.each([
  ["/settings/organization", "/settings/organization/general", {}],
  ["/settings/organization/", "/settings/organization/general", {}],
  ["/admin", "/settings/organization/general", {}],
  ["/admin/", "/settings/organization/general", {}],
  ["/admin/members?q=alice", "/settings/organization/members", { q: "alice" }],
])(
  "the route tree redirects %s and preserves its search",
  async (from, pathname, search) => {
    const analyticsValue = createAnalyticsValue(WEB_ROUTE_TEMPLATES);
    const router = createRouter({
      context: {
        analyticsValue,
        queryClient: createAppQueryClient(),
        routeErrorLifecycle: createRouteErrorLifecycleController(
          analyticsValue.analytics,
        ),
      },
      history: createMemoryHistory({ initialEntries: [from] }),
      parseSearch: parseRouteSearch,
      routeTree,
      stringifySearch: stringifyRouteSearch,
    });

    for (const route of Object.values(router.routesById)) {
      if (
        route.id !== "/_protected/admin" &&
        route.id !== "/_protected/settings/organization/"
      ) {
        route.options.beforeLoad = undefined;
      }
      route.options.loader = undefined;
    }

    await router.load();

    expect(router.state.location.pathname).toBe(pathname);
    expect(router.state.location.search).toEqual(search);
  },
);
