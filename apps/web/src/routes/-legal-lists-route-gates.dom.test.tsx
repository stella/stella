import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, expect, spyOn, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/workspaces" });
Object.assign(import.meta.env, { VITE_API_URL: "http://localhost:3001" });

const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async () => Response.json(null), {
  preconnect: () => undefined,
});

const { QueryClient } = await import("@tanstack/react-query");
const { isNotFound } = await import("@tanstack/react-router");
const { CALLER_FEATURE } =
  await import("@/lib/organization/feature-access/surfaces");
const { Route } = await import("./_protected.workspaces/$workspaceId/lists");

// Exercise the actual file-route loader with the same context shape the router supplies.
const loader: unknown = Route.options.loader;
if (typeof loader !== "function") {
  throw new TypeError("Lists route must have an admission loader");
}

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await unregisterDomEnvironment();
});

for (const deploymentEnabled of [false, true]) {
  for (const status of [undefined, "hidden", "enabled"] as const) {
    test(`Lists route admission: deployment ${String(deploymentEnabled)}, verification ${status ?? "undeclared"}`, async () => {
      const queryClient = new QueryClient();
      const discovery = spyOn(queryClient, "query").mockResolvedValue({
        declaredFeatureIds: [CALLER_FEATURE.verification.id],
        deploymentFeatures: { legalLists: deploymentEnabled },
        capabilities:
          status === undefined
            ? {}
            : {
                [CALLER_FEATURE.verification.id]: { status },
              },
      });

      try {
        const outcome: unknown = await Promise.resolve()
          .then(() =>
            loader({
              context: {
                queryClient,
                user: { id: "caller-a", activeOrganizationId: "org-a" },
              },
              params: { workspaceId: "matter-a" },
            }),
          )
          .then(
            () => undefined,
            (error: unknown) => error,
          );
        const enabled = deploymentEnabled && status === "enabled";
        if (enabled) {
          expect(outcome).toBeUndefined();
          expect(discovery).toHaveBeenCalledTimes(2);
          expect(discovery.mock.calls.at(-1)?.at(0)).toMatchObject({
            queryKey: ["legal-lists", "matter-a"],
          });
        } else {
          expect(isNotFound(outcome)).toBe(true);
          expect(discovery).toHaveBeenCalledTimes(1);
        }
      } finally {
        discovery.mockRestore();
        queryClient.clear();
      }
    });
  }
}
