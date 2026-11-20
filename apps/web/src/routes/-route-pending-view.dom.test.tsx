import { renderToStaticMarkup } from "react-dom/server";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { RouteComponent } from "@tanstack/react-router";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import messages from "@/i18n/langs/en.json";
import { APP_FRAME_SCOPE } from "@/routes/-app-frame-scope";

GlobalRegistrator.register({ url: "http://localhost:3000/" });

const testing = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");
const { IntlProvider } = await import("use-intl");
const { AppFrameHost } = await import("@/routes/-app-frame-host");
const { RootPendingComponent } = await import("@/routes/-root-pending");
const { framePendingView } = await import("@/routes/-pending-view.logic");
const { LeafPendingView, redirectRouteComponent } =
  await import("@/routes/-route-pending-view");
const { ProtectedPendingSkeleton } =
  await import("@/routes/-protected-pending-skeleton");
const { rememberTimeBillingAccess } =
  await import("@/lib/workspaces/time-billing-access-memory");
const { initializeBrowserPresentationPrefs, PresentationPrefsProvider } =
  await import("@/lib/account/presentation-prefs/provider");
const { createTestPresentationPrefsSync } =
  await import("@/lib/account/presentation-prefs/sync.test-fixtures");
const { isPublicLawEnabled } = await import("@/lib/public-law-launch");

afterEach(() => {
  testing.cleanup();
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

const PagePending = framePendingView(() => <p data-testid="page-pending" />);
// A pending view outside the contract (it may read app context), which the
// frame must not draw before the providers mount.
const ContextPending = () => <p data-testid="context-pending" />;
const Page = () => <p data-testid="page" />;
// A redirect that runs its own navigation (a target with made-up params, or
// one a read decides), held here so the pending phase can be looked at.
const HeldNavigator = () => <p data-testid="held-navigator" />;

/**
 * A member-frame app whose guard has not put a user in context yet, so the
 * frame host shows its pending skeleton: `/chat` declares its pending view,
 * `/plain` declares one outside the contract, `/go` only redirects to
 * `/chat`, and `/section` is a
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
    pendingComponent: ContextPending,
    component: Page,
  });
  const redirectRoute = router.createRoute({
    getParentRoute: () => memberRoute,
    path: "/go",
    component: redirectRouteComponent({ to: "/chat" }),
  });
  const navigatorRoute = router.createRoute({
    getParentRoute: () => memberRoute,
    path: "/new",
    component: redirectRouteComponent({
      navigator: HeldNavigator,
      to: "/chat",
    }),
  });
  // Outside the member frame, as the root route is: it sends a member on
  // into the app once the session is read.
  const framelessRedirectRoute = router.createRoute({
    getParentRoute: () => rootRoute,
    path: "/home",
    staticData: { appFrame: APP_FRAME_SCOPE.none },
    component: redirectRouteComponent({
      navigator: HeldNavigator,
      to: "/chat",
    }),
  });
  const standaloneRoute = router.createRoute({
    getParentRoute: () => rootRoute,
    path: "/standalone",
    staticData: { appFrame: APP_FRAME_SCOPE.none },
    component: Page,
    pendingComponent: PagePending,
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
      framelessRedirectRoute,
      standaloneRoute,
      memberRoute.addChildren([
        chatRoute,
        plainRoute,
        redirectRoute,
        navigatorRoute,
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
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <router.RouterProvider router={appRouter} />
      </IntlProvider>
    </QueryClientProvider>,
  );
};

test("the frame's pending skeleton shows the page's own pending view", async () => {
  const view = await renderAt("/chat");
  expect(view.queryByTestId("page-pending")).not.toBeNull();
  expect(view.queryByTestId("page")).toBeNull();
});

test("a pending view outside the contract leaves the frame its generic body", async () => {
  const view = await renderAt("/plain");
  expect(view.queryByTestId("context-pending")).toBeNull();
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
  // No text in a locale: the client hydrates this paint before it restores
  // the account's locale, so the frame's labels are bars here.
  expect(
    view.container.querySelector('[data-slot="pending-sidebar"]')?.textContent,
  ).toBe("");
});

test("the root paints a standalone page in its own pending view", async () => {
  const view = await renderAt("/standalone", RootPendingComponent);
  expect(
    view.getByRole("status").contains(view.getByTestId("page-pending")),
  ).toBe(true);
  expect(
    view.container.querySelector('[data-slot="pending-sidebar"]'),
  ).toBeNull();
});

test("a redirect that runs its own navigation shows its target's pending view meanwhile", async () => {
  // The redirect's own component, as it renders once the frame is up.
  const view = await renderAt("/new", () => <router.Outlet />);
  expect(view.queryByTestId("held-navigator")).not.toBeNull();
  expect(view.queryByTestId("page-pending")).not.toBeNull();
});

test("a frameless redirect into the app shows its target in the member frame", async () => {
  const view = await renderAt("/home");
  expect(view.queryByTestId("page-pending")).not.toBeNull();
  expect(
    view.container.querySelector('[data-slot="inspector-pending-dock"]'),
  ).not.toBeNull();
  // The cold-load paint of it too.
  testing.cleanup();
  const root = await renderAt("/home", RootPendingComponent);
  expect(root.queryByTestId("page-pending")).not.toBeNull();
  expect(
    root.container.querySelector('[data-slot="inspector-pending-dock"]'),
  ).not.toBeNull();
});

const ORGANIZATION_ID = "00000000-0000-7000-8000-00000000abcd";

// The presentation cookie as this browser holds it: what the skeleton reads,
// and where remembering an answer writes.
const prefsSync = createTestPresentationPrefsSync();
initializeBrowserPresentationPrefs(prefsSync.getSnapshot(), prefsSync);

const pendingNavIds = (scope?: { userId: string; organizationId: string }) => {
  const view = testing.render(
    <PresentationPrefsProvider
      initialPrefs={prefsSync.getSnapshot()}
      sync={prefsSync}
    >
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        {scope === undefined ? (
          <ProtectedPendingSkeleton />
        ) : (
          <ProtectedPendingSkeleton inspectorScope={scope} />
        )}
      </IntlProvider>
    </PresentationPrefsProvider>,
  );
  const ids = [
    ...view.container.querySelectorAll<HTMLElement>("[data-nav-item]"),
  ].map((row) => row.dataset["navItem"]);
  testing.cleanup();
  return ids;
};

test("the frame's nav has the entries the build gives the sidebar", () => {
  const ids = pendingNavIds();
  expect(ids).toContain("chat");
  expect(ids.includes("caseLaw")).toBe(isPublicLawEnabled());
});

test("the frame's nav keeps the timesheets entry this browser last had", async () => {
  const scope = { userId: "user-1", organizationId: ORGANIZATION_ID };
  // The cookie write is detached; it lands in the browser's prefs.
  const remember = async (enabled: boolean) => {
    rememberTimeBillingAccess(ORGANIZATION_ID, enabled);
    await testing.waitFor(() => {
      expect(prefsSync.getSnapshot().timeBillingHint).toBe(enabled);
    });
  };
  await remember(false);
  expect(pendingNavIds(scope)).not.toContain("timesheets");
  expect(pendingNavIds()).not.toContain("timesheets");
  await remember(true);
  expect(pendingNavIds(scope)).toContain("timesheets");
  // Before the frame knows the member's organization (the server's paint and
  // its hydration), the answer kept in the presentation cookie stands in.
  expect(prefsSync.getSnapshot().timeBillingHint).toBe(true);
  expect(pendingNavIds()).toContain("timesheets");
  expect(pendingNavIds(scope)).toContain("timesheets");
  await remember(false);
  expect(pendingNavIds()).not.toContain("timesheets");
});

// The jump this guards is in the server's paint, which renders with the
// stores' server snapshots: the frame must take the cookie's answer there.
test("the server's paint of the frame's nav follows the presentation cookie", () => {
  const serverNav = (timeBillingHint: boolean) => {
    const prefs = { ...prefsSync.getSnapshot(), timeBillingHint };
    return renderToStaticMarkup(
      <PresentationPrefsProvider
        initialPrefs={prefs}
        sync={createTestPresentationPrefsSync(prefs)}
      >
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <ProtectedPendingSkeleton />
        </IntlProvider>
      </PresentationPrefsProvider>,
    );
  };
  expect(serverNav(true)).toContain('data-nav-item="timesheets"');
  expect(serverNav(false)).not.toContain('data-nav-item="timesheets"');
});
