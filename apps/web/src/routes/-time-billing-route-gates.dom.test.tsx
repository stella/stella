import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, describe, expect, test } from "bun:test";

import { SMOKE_ROUTE_DEFS } from "../../e2e/helpers/smoke-route-defs";
import { listTimeBillingRoutes } from "../../e2e/helpers/time-billing-routes";

GlobalRegistrator.register({ url: "http://localhost:3000/workspaces" });
Object.assign(import.meta.env, {
  VITE_API_URL: "http://localhost:3001",
  VITE_BETA_FEATURES_ENABLED: "true",
});

const originalFetch = globalThis.fetch;
// Auth imports may prime the session; billing reads must remain behind admission.
const requests: string[] = [];
globalThis.fetch = Object.assign(
  async (input: RequestInfo | URL) => {
    requests.push(input instanceof Request ? input.url : String(input));
    return Response.json(null);
  },
  { preconnect: () => undefined },
);

const { QueryClient } = await import("@tanstack/react-query");
const { isRedirect } = await import("@tanstack/react-router");
const { roleOptions } = await import("@/lib/auth-queries");
const { workspacesNavigationOptions } =
  await import("@/lib/workspaces/queries");

const CALLER = { userId: "unenrolled-owner", organizationId: "org-a" };

const readBeforeLoad = async (filePath: string) => {
  const module: unknown = await import(filePath);
  if (typeof module !== "object" || module === null || !("Route" in module)) {
    throw new TypeError(`Missing route export: ${filePath}`);
  }
  const route = module.Route;
  if (typeof route !== "object" || route === null || !("options" in route)) {
    throw new TypeError(`Missing route options: ${filePath}`);
  }
  const options = route.options;
  if (
    typeof options !== "object" ||
    options === null ||
    !("beforeLoad" in options)
  ) {
    throw new TypeError(`Missing admission guard: ${filePath}`);
  }
  const beforeLoad = options.beforeLoad;
  if (typeof beforeLoad !== "function") {
    throw new TypeError(`Missing admission guard: ${filePath}`);
  }
  return beforeLoad;
};

const redirectDestination = (routePath: string) => {
  if (routePath.startsWith("/_protected/workspaces/")) {
    return "/workspaces/$workspaceId";
  }
  if (routePath.startsWith("/_protected/settings/organization/")) {
    return "/settings/organization/members";
  }
  return "/workspaces";
};

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await GlobalRegistrator.unregister();
});

for (const flowsEnabled of [false, true]) {
  test(`the workflow route admits ${String(flowsEnabled)} and smoke follows its disabled destination`, async () => {
    const beforeLoad = await readBeforeLoad(
      "./_protected.workspaces/$workspaceId/workflows",
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(workspacesNavigationOptions(CALLER).queryKey, {
      workspaces: [],
      features: { timeBilling: false, signals: false, flows: flowsEnabled },
    });
    const requestCount = requests.length;
    try {
      const outcome: unknown = await Promise.resolve()
        .then(() =>
          beforeLoad({
            context: {
              queryClient,
              user: {
                id: CALLER.userId,
                activeOrganizationId: CALLER.organizationId,
              },
            },
            params: { workspaceId: "matter-a" },
          }),
        )
        .then(
          () => null,
          (error: unknown) => error,
        );
      if (flowsEnabled) {
        expect(outcome).toBeNull();
      } else {
        expect(isRedirect(outcome)).toBe(true);
        if (!isRedirect(outcome)) {
          throw new TypeError("Workflow admission did not redirect", {
            cause: outcome,
          });
        }
        expect(outcome.options.to).toBe("/workspaces/$workspaceId");
        expect(outcome.options.params).toMatchObject({
          workspaceId: "matter-a",
        });
        const smoke = SMOKE_ROUTE_DEFS.find(
          ({ template }) => template === "/workspaces/$workspaceId/workflows",
        );
        expect(smoke?.expectation).toEqual({ kind: "redirectsTo", to: "" });
      }
      expect(requests.slice(requestCount)).toEqual([]);
    } finally {
      queryClient.clear();
    }
  });
}

describe("server enrollment admission across dedicated billing routes", () => {
  const routes = listTimeBillingRoutes();

  test("the source census contains guarded routes", () => {
    expect(routes.length).toBeGreaterThan(0);
    expect(new Set(routes.map(({ routePath }) => routePath)).size).toBe(
      routes.length,
    );
  });

  for (const { routePath, guardFilePath } of routes) {
    test(`${routePath} redirects an unenrolled owner before loading billing`, async () => {
      const beforeLoad = await readBeforeLoad(guardFilePath);
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      queryClient.setQueryData(workspacesNavigationOptions(CALLER).queryKey, {
        workspaces: [],
        features: { timeBilling: false, signals: false, flows: false },
      });
      queryClient.setQueryData(roleOptions.queryKey, "owner");
      const requestCount = requests.length;
      const params = { workspaceId: "matter-a", invoiceId: "invoice-a" };
      const outcome: unknown = await Promise.resolve()
        .then(() =>
          beforeLoad({
            context: {
              queryClient,
              user: {
                id: CALLER.userId,
                activeOrganizationId: CALLER.organizationId,
              },
            },
            params,
            location: { pathname: routePath.replace("/_protected", "") },
          }),
        )
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(isRedirect(outcome)).toBe(true);
      if (!isRedirect(outcome)) {
        throw new TypeError(`Admission did not redirect: ${routePath}`, {
          cause: outcome,
        });
      }
      expect(outcome.options.to).toBe(redirectDestination(routePath));
      if (routePath.startsWith("/_protected/workspaces/")) {
        expect(outcome.options.params).toMatchObject({
          workspaceId: params.workspaceId,
        });
      }
      expect(requests.slice(requestCount)).toEqual([]);
      queryClient.clear();
    });
  }
});
