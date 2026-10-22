import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, expect, test } from "bun:test";

import { sleep } from "@stll/concurrency/sleep";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/law" });

const testing = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");
const { getBrowserClientCapability, isBrowserExtensionBridgeMounted } =
  await import("@/features/chat/browser-control/browser-extension-bridge");
const { APP_FRAME_SCOPE } = await import("@/routes/-app-frame-scope");
const { AppFrameHost } = await import("@/routes/-app-frame-host");
const { BROWSER_CONTROL_PROTOCOL_VERSION, BROWSER_EXTENSION_MESSAGE_SOURCE } =
  await import("@stll/api-contract/browser-control");

afterAll(async () => {
  testing.cleanup();
  await testing.act(async () => {
    await sleep(50);
  });
  await unregisterDomEnvironment();
});

test("a route with no app frame still has the extension bridge, across navigation", async () => {
  const queryClient = new QueryClient();
  const rootRoute = router.createRootRoute({
    component: () => (
      <AppFrameHost>
        <router.Outlet />
      </AppFrameHost>
    ),
  });
  const lawRoute = router.createRoute({
    getParentRoute: () => rootRoute,
    path: "/law",
    staticData: { appFrame: APP_FRAME_SCOPE.none },
    component: () => <p data-testid="law" />,
  });
  const otherRoute = router.createRoute({
    getParentRoute: () => rootRoute,
    path: "/other",
    staticData: { appFrame: APP_FRAME_SCOPE.none },
    component: () => <p data-testid="other" />,
  });
  const appRouter = router.createRouter({
    history: router.createMemoryHistory({ initialEntries: ["/law"] }),
    isServer: false,
    routeTree: rootRoute.addChildren([lawRoute, otherRoute]),
  });
  await appRouter.load();
  const view = testing.render(
    <QueryClientProvider client={queryClient}>
      <router.RouterProvider router={appRouter} />
    </QueryClientProvider>,
  );
  try {
    await testing.waitFor(() => view.getByTestId("law"));
    expect(isBrowserExtensionBridgeMounted()).toBe(true);

    testing.act(() => {
      window.dispatchEvent(
        new window.MessageEvent("message", {
          data: {
            allSitesGranted: true,
            controlledTabId: null,
            controllerId: "controller-law",
            protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
            requestId: "pong-1",
            source: BROWSER_EXTENSION_MESSAGE_SOURCE.extension,
            type: "pong",
          },
          origin: window.location.origin,
          source: window,
        }),
      );
    });
    expect(getBrowserClientCapability()).toEqual({
      protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
    });

    testing.act(() => {
      // The test router has its own route tree, outside the app's typed paths.
      appRouter.history.push("/other");
    });
    await testing.waitFor(() => view.getByTestId("other"));
    expect(isBrowserExtensionBridgeMounted()).toBe(true);
    expect(getBrowserClientCapability()).toBeDefined();
  } finally {
    view.unmount();
    queryClient.clear();
  }
  expect(isBrowserExtensionBridgeMounted()).toBe(false);
});
