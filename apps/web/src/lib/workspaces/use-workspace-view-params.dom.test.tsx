import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000" });

const { act, cleanup, render } = await import("@testing-library/react");
const {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} = await import("@tanstack/react-router");
const { useWorkspaceViewParams } =
  await import("@/lib/workspaces/use-workspace-view-params");
const { DEFAULT_WORKSPACE_VIEW_ID } =
  await import("@/lib/workspaces/view-params.logic");

const matterA = "019a0000-0000-7000-8000-000000000301";
const matterB = "019a0000-0000-7000-8000-000000000302";
const filesViewId = "019a0000-0000-7000-8000-000000000303";

/** Renders the params a navigation into each matter would open under. */
const Probe = () => {
  const intoA = useWorkspaceViewParams(matterA);
  const intoB = useWorkspaceViewParams(matterB);
  return (
    <output data-testid="params">{JSON.stringify({ intoA, intoB })}</output>
  );
};

const mountAt = async (initialEntry: string) => {
  const root = createRootRoute({
    component: () => (
      <>
        <Probe />
        <Outlet />
      </>
    ),
  });
  const protectedRoute = createRoute({
    getParentRoute: () => root,
    id: "_protected",
    component: Outlet,
  });
  const workspace = createRoute({
    getParentRoute: () => protectedRoute,
    path: "workspaces/$workspaceId",
    component: Outlet,
  });
  const view = createRoute({
    getParentRoute: () => workspace,
    path: "$viewId",
    component: Outlet,
  });
  const documentRoute = createRoute({
    getParentRoute: () => view,
    path: "document",
  });
  const chat = createRoute({
    getParentRoute: () => protectedRoute,
    path: "chat",
  });
  const router = createRouter({
    routeTree: root.addChildren([
      protectedRoute.addChildren([
        workspace.addChildren([view.addChildren([documentRoute])]),
        chat,
      ]),
    ]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
  await router.load();
  const mounted = render(<RouterProvider router={router} />);
  return (await mounted.findByTestId("params")).textContent;
};

afterEach(async () => {
  await act(async () => cleanup());
});

afterAll(async () => {
  await unregisterDomEnvironment();
});

describe("the view a matter navigation opens under", () => {
  test("keeps the view on screen for its matter, under the view and its document", async () => {
    const expected = {
      intoA: { workspaceId: matterA, viewId: filesViewId },
      intoB: { workspaceId: matterB, viewId: DEFAULT_WORKSPACE_VIEW_ID },
    };
    expect(await mountAt(`/workspaces/${matterA}/${filesViewId}`)).toBe(
      JSON.stringify(expected),
    );
    await act(async () => cleanup());
    expect(
      await mountAt(`/workspaces/${matterA}/${filesViewId}/document?entity=e`),
    ).toBe(JSON.stringify(expected));
  });

  test("opens every matter under its default view off any matter view", async () => {
    expect(await mountAt("/chat")).toBe(
      JSON.stringify({
        intoA: { workspaceId: matterA, viewId: DEFAULT_WORKSPACE_VIEW_ID },
        intoB: { workspaceId: matterB, viewId: DEFAULT_WORKSPACE_VIEW_ID },
      }),
    );
  });
});
