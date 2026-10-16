import { createContext } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, expect, test } from "bun:test";

import { PROVIDER_SCOPE } from "@/routes/-app-frame-scope";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/scope-fixture" });

const { act, cleanup, render, waitFor } =
  await import("@testing-library/react");
const {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} = await import("@tanstack/react-router");
const { RouteProviderScopeBoundary, useRequiredRouteProvider } =
  await import("./route-provider-scope");

afterAll(unregisterDomEnvironment);

for (const scope of Object.values(PROVIDER_SCOPE)) {
  for (const declared of [false, true]) {
    for (const provided of [false, true]) {
      test(`${scope}: requires both a declared scope (${declared}) and a mounted provider (${provided})`, async () => {
        const Context = createContext<string | null>(null);
        const root = createRootRoute({
          component: () => (
            <RouteProviderScopeBoundary>
              <Context value={provided ? "available" : null}>
                <Outlet />
              </Context>
            </RouteProviderScopeBoundary>
          ),
        });
        const Probe = () => {
          const value = useRequiredRouteProvider({
            context: Context,
            scope,
            missingMessage: "Fixture provider unavailable",
          });
          return <output>{value}</output>;
        };
        const route = createRoute({
          getParentRoute: () => root,
          path: "scope-fixture",
          staticData: { providerScopes: declared ? [scope] : [] },
          component: Probe,
          errorComponent: ({ error }) => (
            <output>
              {error instanceof Error ? error.message : String(error)}
            </output>
          ),
        });
        const router = createRouter({
          routeTree: root.addChildren([route]),
          history: createMemoryHistory({ initialEntries: ["/scope-fixture"] }),
        });
        let expected = "available";
        if (!declared) {
          expected = `Route /scope-fixture is missing declared provider scope: ${scope}`;
        } else if (!provided) {
          expected = `Route /scope-fixture is missing provider scope: ${scope}. Fixture provider unavailable`;
        }
        try {
          await act(async () => {
            await router.load();
            render(<RouterProvider router={router} />);
          });
          await waitFor(() =>
            expect(document.querySelector("output")?.textContent).toBe(
              expected,
            ),
          );
        } finally {
          cleanup();
        }
      });
    }
  }
}
