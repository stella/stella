import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { plugin } from "bun";
import { afterAll, afterEach, expect, test } from "bun:test";

import messages from "@/i18n/langs/en.json";
import { toSafeId } from "@/lib/safe-id";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000" });
// Vite emits a URL for worker assets; this flow never starts the worker.
plugin({
  name: "worker-url",
  setup(build) {
    build.onLoad({ filter: /\?worker&url$/u }, () => ({
      contents: 'export default "/worker.js";',
      loader: "js",
    }));
  },
});
const { act, cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} = await import("@tanstack/react-router");
const { IntlProvider } = await import("use-intl");
const { TooltipProvider } = await import("@stll/ui/tooltip");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { createRouteErrorLifecycleController } =
  await import("@/lib/analytics/route-error-lifecycle");
const { RouteErrorLifecycleProvider } =
  await import("@/lib/analytics/route-error-lifecycle-context");
const { InspectorPanel } = await import("./inspector-panel");
const { useInspectorTabsStore } = await import("./inspector-tabs-store");
const { roleOptions } = await import("@/lib/auth-queries");

afterEach(async () => {
  await act(async () => cleanup());
  useInspectorTabsStore.setState(useInspectorTabsStore.getInitialState(), true);
});
afterAll(unregisterDomEnvironment);

for (const { destination, expectedScope } of [
  {
    destination: "/workspaces/matter-B",
    expectedScope: { workspaceId: "matter-B", contextMatterIds: ["matter-B"] },
  },
  {
    destination: "/chat",
    expectedScope: { workspaceId: undefined, contextMatterIds: [] },
  },
] as const) {
  test(`the inspector starts a chat in the current route after navigating to ${destination}`, async () => {
    const store = useInspectorTabsStore.getState();
    store.openChat({
      workspaceId: "matter-A",
      contextMatterIds: ["matter-A"],
      label: "Existing matter A conversation",
    });
    store.setMinimized(true);
    const existingTab = useInspectorTabsStore.getState().tabs.at(0);
    if (existingTab === undefined) {
      throw new Error("Expected the existing matter conversation tab");
    }
    expect(existingTab).toMatchObject({ workspaceId: "matter-A" });

    const client = new QueryClient({
      defaultOptions: {
        queries: { enabled: false, retry: false, staleTime: Infinity },
        mutations: { retry: false },
      },
    });
    client.setQueryData(roleOptions.queryKey, "member");
    const root = createRootRoute({
      component: () => (
        <>
          <Outlet />
          {/* The retained active tab still owns the panel's display context. */}
          <InspectorPanel workspaceId="matter-A" />
        </>
      ),
    });
    const protectedRoute = createRoute({
      getParentRoute: () => root,
      id: "_protected",
      component: Outlet,
    });
    const matterRoute = createRoute({
      getParentRoute: () => protectedRoute,
      path: "workspaces/$workspaceId",
      component: () => null,
    });
    const chatRoute = createRoute({
      getParentRoute: () => protectedRoute,
      path: "chat",
      component: () => null,
    });
    const router = createRouter({
      routeTree: root.addChildren([
        protectedRoute.addChildren([matterRoute, chatRoute]),
      ]),
      history: createMemoryHistory({
        initialEntries: ["/workspaces/matter-A"],
      }),
    });
    await router.load();
    const lifecycle = createRouteErrorLifecycleController({
      captureError: () => undefined,
      captureRouteErrorLifecycle: async () => undefined,
    });
    const view = render(
      <QueryClientProvider client={client}>
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <FormattingProvider locale="en" timeZone="UTC">
            <AuthenticatedUserProvider
              user={{
                id: "navigation-user",
                activeOrganizationId: "navigation-org",
                email: "navigation@example.test",
                image: null,
                name: "Navigation tester",
                preferredName: null,
                timezoneId: "UTC",
                wordEditShortcut: null,
              }}
            >
              <RouteErrorLifecycleProvider controller={lifecycle}>
                <TooltipProvider>
                  <RouterProvider router={router} />
                </TooltipProvider>
              </RouteErrorLifecycleProvider>
            </AuthenticatedUserProvider>
          </FormattingProvider>
        </IntlProvider>
      </QueryClientProvider>,
    );
    try {
      await act(async () => {
        if (destination === "/chat") {
          await router.navigate({ to: "/chat" });
          return;
        }
        await router.navigate({
          to: "/workspaces/$workspaceId",
          params: { workspaceId: toSafeId<"workspace">("matter-B") },
        });
      });
      await waitFor(() =>
        expect(router.state.location.pathname).toBe(destination),
      );
      expect(useInspectorTabsStore.getState().tabs).toEqual([existingTab]);
      await act(async () => {
        fireEvent.click(
          view.getByRole("button", { name: messages.chat.newChat }),
        );
        // The assertion concerns creation; stop before the new thread reads its transcript.
        view.unmount();
      });
      const { activeId, tabs } = useInspectorTabsStore.getState();
      expect(tabs.find((tab) => tab.id === existingTab.id)).toEqual(
        existingTab,
      );
      expect(tabs).toHaveLength(2);
      expect(tabs.find((tab) => tab.id === activeId)).toMatchObject({
        type: "chat",
        workspaceId: expectedScope.workspaceId,
        contextMatterIds: expectedScope.contextMatterIds,
      });
    } finally {
      view.unmount();
      client.clear();
    }
  });
}
