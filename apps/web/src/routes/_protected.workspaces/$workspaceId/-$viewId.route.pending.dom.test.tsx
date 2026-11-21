import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { RouteComponent } from "@tanstack/react-router";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/workspaces" });

const testing = await import("@testing-library/react");
const { QueryClient } = await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");
const { renderToString } = await import("react-dom/server");
const { PendingCacheScope } = await import("@/components/pending-cache");
const { toSafeId } = await import("@/lib/safe-id");
const { propertiesQueryRoot } =
  await import("@/lib/resource-query-roots.logic");
const { viewsRootKey } = await import("@/lib/workspaces/queries/views.logic");
const { ViewBodySlot, ViewPending } = await import("./-$viewId.route.pending");

afterEach(() => {
  testing.cleanup();
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

const WORKSPACE_ID = "00000000-0000-7000-8000-0000000000aa";

const tableView = {
  version: 1,
  id: "view-table",
  name: "Documents",
  position: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  layout: {
    version: 1,
    type: "table",
    filters: [],
    sorts: [],
    hiddenProperties: [toSafeId<"property">("hidden")],
    calculations: [],
    columnOrder: [],
    columnPinning: [],
  },
} as const;

const boardView = {
  ...tableView,
  id: "view-board",
  name: "Board",
  position: 1,
  layout: {
    version: 1,
    type: "kanban",
    filters: [],
    sorts: [],
    hiddenProperties: [],
    calculations: [],
  },
} as const;

const property = (id: string) => ({
  id: toSafeId<"property">(id),
  name: id,
  createdAt: "2026-01-01T00:00:00.000Z",
  workspaceId: toSafeId<"workspace">(WORKSPACE_ID),
  status: "fresh",
  kinds: null,
  content: { version: 1, type: "text" },
  tool: { version: 1, type: "manual-input" },
});

/** A cache that holds what a matter opened before leaves behind. */
const warmCache = () => {
  const cache = new QueryClient();
  cache.setQueryData(
    [...viewsRootKey(WORKSPACE_ID), "en"],
    [tableView, boardView],
  );
  cache.setQueryData(propertiesQueryRoot(WORKSPACE_ID), [
    property("shown"),
    property("hidden"),
  ]);
  return cache;
};

/** The view's route at `pathname`, drawing `Page` as its component. */
const viewRouter = async (pathname: string, Page: RouteComponent) => {
  const rootRoute = router.createRootRoute({ component: router.Outlet });
  const viewRoute = router.createRoute({
    getParentRoute: () => rootRoute,
    path: "/workspaces/$workspaceId/$viewId",
    component: Page,
  });
  const appRouter = router.createRouter({
    history: router.createMemoryHistory({ initialEntries: [pathname] }),
    isServer: false,
    routeTree: rootRoute.addChildren([viewRoute]),
  });
  await appRouter.load();
  return appRouter;
};

const renderAt = async (pathname: string, Page: RouteComponent) => {
  const appRouter = await viewRouter(pathname, Page);
  return testing.render(<router.RouterProvider router={appRouter} />);
};

const gridHeads = (container: HTMLElement) =>
  container.querySelectorAll('[data-slot="workspace-grid-head"]');

test("before any cache, the view claims no layout: tab bars and an empty body", async () => {
  const { container } = await renderAt(
    `/workspaces/${WORKSPACE_ID}/view-table`,
    () => <ViewPending />,
  );
  expect(
    container.querySelectorAll('[data-slot="face-label-skeleton"]').length,
  ).toBe(2);
  expect(gridHeads(container).length).toBe(0);
  expect(
    container.querySelector('[data-slot="workspace-view-switcher"]'),
  ).toBeNull();
});

test("the server paint reads no cache, even inside the app's scope", async () => {
  const appRouter = await viewRouter(
    `/workspaces/${WORKSPACE_ID}/view-table`,
    () => (
      <PendingCacheScope client={warmCache()}>
        <ViewPending />
      </PendingCacheScope>
    ),
  );
  const html = renderToString(<router.RouterProvider router={appRouter} />);
  expect(html).not.toContain("workspace-grid-head");
  expect(html).not.toContain("Documents");
});

test("a cached table view draws its tabs and the table's own grid, without hidden columns", async () => {
  const { container, getAllByText } = await renderAt(
    `/workspaces/${WORKSPACE_ID}/view-table`,
    () => (
      <PendingCacheScope client={warmCache()}>
        <ViewPending />
      </PendingCacheScope>
    ),
  );
  expect(getAllByText("Documents").length).toBeGreaterThan(0);
  expect(getAllByText("Board").length).toBeGreaterThan(0);
  const heads = gridHeads(container);
  // Selection, the shown property, author, updated, version, the filler and
  // the add-property head; the hidden property has none.
  expect(heads.length).toBe(7);
  const style = container
    .querySelector('[data-slot="workspace-grid-row"]')
    ?.closest("[style]")
    ?.getAttribute("style");
  expect(style).toContain("--workspace-table-columns");
});

test("a cached board claims no columns before the board resolves them", async () => {
  const { container, getAllByText } = await renderAt(
    `/workspaces/${WORKSPACE_ID}/view-board`,
    () => (
      <PendingCacheScope client={warmCache()}>
        <ViewPending />
      </PendingCacheScope>
    ),
  );
  expect(getAllByText("Board").length).toBeGreaterThan(0);
  expect(gridHeads(container).length).toBe(0);
});

test("under the loaded tabs row it draws the body alone", async () => {
  const { container } = await renderAt(
    `/workspaces/${WORKSPACE_ID}/view-table`,
    () => (
      <PendingCacheScope client={warmCache()}>
        <ViewBodySlot>
          <ViewPending />
        </ViewBodySlot>
      </PendingCacheScope>
    ),
  );
  expect(
    container.querySelector('[data-slot="workspace-view-switcher"]'),
  ).toBeNull();
  expect(gridHeads(container).length).toBe(7);
});
