import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { RouteComponent } from "@tanstack/react-router";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import messages from "@/i18n/langs/en.json";

GlobalRegistrator.register({ url: "http://localhost:3000/workspaces" });

const testing = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");
const { renderToString } = await import("react-dom/server");
const { hydrateRoot } = await import("react-dom/client");
const { IntlProvider } = await import("use-intl");
const { useConfigStore } = await import("@/stores/config-store");
const { MattersPending } = await import("./-matters.pending");
const { MattersToolbar } =
  await import("@/routes/_protected.workspaces/-components/matters-toolbar");

const initialMatters = useConfigStore.getState().matters;

afterEach(() => {
  testing.cleanup();
  useConfigStore.setState({ matters: initialMatters });
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

const user = {
  activeOrganizationId: "00000000-0000-7000-8000-00000000ffff",
  id: "00000000-0000-7000-8000-00000000fffe",
};

/**
 * The matters page's route under the member layout, at `pathname`, drawing
 * `Page`: the pending view, or the live toolbar beside it.
 */
const loadedRouter = async (pathname: string, Page: RouteComponent) => {
  const rootRoute = router.createRootRoute({ component: router.Outlet });
  const memberRoute = router.createRoute({
    getParentRoute: () => rootRoute,
    id: "_protected",
    beforeLoad: () => ({ user }),
    component: router.Outlet,
  });
  const mattersRoute = router.createRoute({
    getParentRoute: () => memberRoute,
    path: "/workspaces",
    component: Page,
  });
  const appRouter = router.createRouter({
    history: router.createMemoryHistory({ initialEntries: [pathname] }),
    isServer: false,
    routeTree: rootRoute.addChildren([memberRoute.addChildren([mattersRoute])]),
  });
  await appRouter.load();
  return appRouter;
};

// No read leaves the test: the role and the matters list stay unread, as on
// a cold load before the page's own reads.
const quietClient = () =>
  new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false } },
  });

const keepTableLayout = () => {
  useConfigStore.setState({
    matters: {
      ...initialMatters,
      viewMode: "table",
      hiddenColumns: ["team"],
      sortKey: "name",
      sortDesc: false,
    },
  });
};

const toolbarOf = (root: ParentNode) => {
  const toolbar = root.querySelector('[data-slot="matters-toolbar"]');
  if (toolbar === null) {
    throw new Error("no matters toolbar");
  }
  return toolbar;
};

test("the server paint and the hydration pass claim no layout; the kept table follows", async () => {
  keepTableLayout();
  const appRouter = await loadedRouter("/workspaces", MattersPending);
  const tree = (
    <QueryClientProvider client={quietClient()}>
      <router.RouterProvider router={appRouter} />
    </QueryClientProvider>
  );
  const container = document.createElement("div");
  // safe-html: React renderToString output of the local pending view.
  container.innerHTML = renderToString(tree);
  // The browser keeps a table layout, which the server cannot know: its
  // paint draws the toolbar and no table, grid or cards.
  expect(toolbarOf(container).childElementCount).toBe(6);
  expect(container.querySelector("table")).toBeNull();
  expect(container.querySelector('[data-slot="frame"]')).toBeNull();
  document.body.append(container);
  const errors: unknown[] = [];
  const root = hydrateRoot(container, tree, {
    onRecoverableError: (error) => {
      errors.push(error);
    },
  });
  try {
    await testing.waitFor(() => {
      expect(container.querySelector("table") !== null).toBe(true);
    });
    expect(errors).toEqual([]);
    // The kept layout: the table with the member's columns (all but the
    // hidden team), a head per column and placeholder rows under them.
    expect(container.querySelectorAll("col").length).toBe(6);
    expect(container.querySelectorAll("thead th").length).toBe(6);
    expect(
      container.querySelectorAll("tbody tr").length,
    ).toBeGreaterThanOrEqual(1);
    expect(container.querySelector("thead th")?.getAttribute("aria-sort")).toBe(
      "ascending",
    );
  } finally {
    await testing.act(async () => {
      root.unmount();
    });
    container.remove();
  }
});

test("the toolbar's face offers no control to use", async () => {
  useConfigStore.setState({ matters: { ...initialMatters, viewMode: "grid" } });
  const appRouter = await loadedRouter(
    "/workspaces?status=archived",
    MattersPending,
  );
  const { container } = testing.render(
    <QueryClientProvider client={quietClient()}>
      <router.RouterProvider router={appRouter} />
    </QueryClientProvider>,
  );
  await testing.waitFor(() => {
    expect(
      container.querySelector('[data-slot="matters-toolbar"]') !== null,
    ).toBe(true);
  });
  const toolbar = toolbarOf(container);
  expect(
    toolbar.querySelectorAll("button, input, a, select, [tabindex]").length,
  ).toBe(0);
  // Without a cached role and list, "New matter" is not claimed.
  expect(toolbar.querySelectorAll('[data-slot="button-face"]').length).toBe(3);
  expect(toolbar.querySelector('[data-slot="input-face"]')).not.toBeNull();
});

test("the loaded toolbar lays its controls out in the face's row", async () => {
  const LiveToolbar = () => (
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <MattersToolbar
        onSearchChange={() => undefined}
        onStatusChange={() => undefined}
        search=""
        searchRef={{ current: null }}
        status="active"
      />
    </IntlProvider>
  );
  const pending = testing.render(
    <QueryClientProvider client={quietClient()}>
      <router.RouterProvider
        router={await loadedRouter("/workspaces", MattersPending)}
      />
    </QueryClientProvider>,
  );
  await testing.waitFor(() => {
    expect(
      pending.container.querySelector('[data-slot="matters-toolbar"]') !== null,
    ).toBe(true);
  });
  const faceRow = toolbarOf(pending.container);
  const live = testing.render(
    <QueryClientProvider client={quietClient()}>
      <router.RouterProvider
        router={await loadedRouter("/workspaces", LiveToolbar)}
      />
    </QueryClientProvider>,
  );
  await testing.waitFor(() => {
    expect(
      live.container.querySelector('[data-slot="matters-toolbar"]') !== null,
    ).toBe(true);
  });
  const liveRow = toolbarOf(live.container);
  expect(liveRow.className).toBe(faceRow.className);
  expect(liveRow.childElementCount).toBe(faceRow.childElementCount);
  // The search field, the status choice, the rule, sort and layout, and the
  // create slot at the end, one for one: the rule and the create slot are
  // the shell's own in both.
  expect(liveRow.children.item(2)?.className).toBe(
    faceRow.children.item(2)?.className,
  );
  expect(liveRow.lastElementChild?.className).toBe(
    faceRow.lastElementChild?.className,
  );
});
