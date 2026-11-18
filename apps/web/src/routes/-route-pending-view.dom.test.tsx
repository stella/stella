import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { RouteComponent } from "@tanstack/react-router";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import { APP_FRAME_SCOPE } from "@/routes/-app-frame-scope";

GlobalRegistrator.register({ url: "http://localhost:3000/" });

const testing = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");
const { AppFrameHost } = await import("@/routes/-app-frame-host");
const { RootPendingComponent } = await import("@/routes/-root-pending");
const { LeafPendingView, redirectRouteComponent } =
  await import("@/routes/-route-pending-view");

afterEach(() => {
  testing.cleanup();
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

const PagePending = () => <p data-testid="page-pending" />;
const Page = () => <p data-testid="page" />;

/**
 * A member-frame app whose guard has not put a user in context yet, so the
 * frame host shows its pending skeleton: `/chat` declares its pending view,
 * `/plain` does not, `/go` only redirects to `/chat`, and `/section` is a
 * layout delegating to its page.
 */
const renderAt = async (
  pathname: string,
  RootComponent: RouteComponent = () => (
    <AppFrameHost>
      <router.Outlet />
    </AppFrameHost>
  ),
) => {
  const rootRoute = router.createRootRoute({ component: RootComponent });
  const memberRoute = router.createRoute({
    getParentRoute: () => rootRoute,
    id: "_protected",
    staticData: { appFrame: APP_FRAME_SCOPE.member },
  });
  const chatRoute = router.createRoute({
    getParentRoute: () => memberRoute,
    path: "/chat",
    component: Page,
    pendingComponent: PagePending,
  });
  const plainRoute = router.createRoute({
    getParentRoute: () => memberRoute,
    path: "/plain",
    component: Page,
  });
  const redirectRoute = router.createRoute({
    getParentRoute: () => memberRoute,
    path: "/go",
    component: redirectRouteComponent({ to: "/chat" }),
  });
  const layoutRoute = router.createRoute({
    getParentRoute: () => memberRoute,
    path: "/section",
    component: () => <router.Outlet />,
    pendingComponent: LeafPendingView,
  });
  const sectionPageRoute = router.createRoute({
    getParentRoute: () => layoutRoute,
    path: "/",
    component: Page,
    pendingComponent: PagePending,
  });
  const appRouter = router.createRouter({
    history: router.createMemoryHistory({ initialEntries: [pathname] }),
    isServer: false,
    routeTree: rootRoute.addChildren([
      memberRoute.addChildren([
        chatRoute,
        plainRoute,
        redirectRoute,
        layoutRoute.addChildren([sectionPageRoute]),
      ]),
    ]),
  });
  await appRouter.load();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return testing.render(
    <QueryClientProvider client={queryClient}>
      <router.RouterProvider router={appRouter} />
    </QueryClientProvider>,
  );
};

test("the frame's pending skeleton shows the page's own pending view", async () => {
  const view = await renderAt("/chat");
  expect(view.queryByTestId("page-pending")).not.toBeNull();
  expect(view.queryByTestId("page")).toBeNull();
});

test("a page without a pending view gets the generic body", async () => {
  const view = await renderAt("/plain");
  expect(view.queryByTestId("page-pending")).toBeNull();
  expect(view.queryByTestId("page")).toBeNull();
  // The frame still stands: its sidebar's primary nav renders for real.
  expect(
    view.container.querySelector('[data-slot="inspector-pending-dock"]'),
  ).not.toBeNull();
});

test("a redirect shows its target's pending view", async () => {
  const view = await renderAt("/go");
  expect(view.queryByTestId("page-pending")).not.toBeNull();
});

test("a layout's pending view is its page's", async () => {
  const view = await renderAt("/section", () => <LeafPendingView />);
  expect(view.queryByTestId("page-pending")).not.toBeNull();
});

test("the root pending paints the member frame around the page's view", async () => {
  const view = await renderAt("/chat", RootPendingComponent);
  expect(view.queryByTestId("page-pending")).not.toBeNull();
  expect(
    view.container.querySelector('[data-slot="inspector-pending-dock"]'),
  ).not.toBeNull();
  expect(view.getByRole("status").getAttribute("aria-busy")).toBe("true");
});
