import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000" });

const { act, cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} = await import("@tanstack/react-router");
const { useInspectorTabsStore } =
  await import("@/components/inspector/inspector-tabs-store");
const { useFileFullViewNavigation } =
  await import("@/components/inspector/use-file-full-view-navigation");
const { detached } = await import("@/lib/detached");

const workspaceId = "019a0000-0000-7000-8000-000000000201";
const filesViewId = "019a0000-0000-7000-8000-000000000202";
const entityId = "019a0000-0000-7000-8000-000000000203";
const fieldId = "019a0000-0000-7000-8000-000000000204";
const folderId = "019a0000-0000-7000-8000-000000000205";

const inspectedFile = () =>
  useInspectorTabsStore
    .getState()
    .tabs.find((tab) => tab.type === "pdf" && tab.id === fieldId) ??
  panic("the file is no longer open in the inspector");

/** The inspector's header controls for the active file: expand into the full
 * document view (marking the lane as the panel does once navigation lands)
 * and the back-to-peek button shown there. */
const FullViewControls = () => {
  const { leaveFullView, openFullView } = useFileFullViewNavigation();
  return (
    <>
      <button
        onClick={() => {
          const tab = inspectedFile();
          detached(
            openFullView(tab, { carryEditing: false }).then(() => {
              useInspectorTabsStore
                .getState()
                .setFileMetadataLane(tab.id, "expanded");
              return undefined;
            }),
            "test.expand",
          );
        }}
        data-testid="expand"
        type="button"
      />
      <button
        data-testid="back-to-peek"
        onClick={() => leaveFullView(inspectedFile())}
        type="button"
      />
    </>
  );
};

const mountMatter = async (initialEntry: string) => {
  const root = createRootRoute({ component: Outlet });
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
    component: () => (
      <>
        <FullViewControls />
        <Outlet />
      </>
    ),
  });
  const viewIndex = createRoute({
    getParentRoute: () => view,
    path: "/",
    component: () => <p data-testid="files-view" />,
  });
  const documentRoute = createRoute({
    getParentRoute: () => view,
    path: "document",
    component: () => <p data-testid="document-view" />,
  });
  const router = createRouter({
    routeTree: root.addChildren([
      protectedRoute.addChildren([
        workspace.addChildren([view.addChildren([viewIndex, documentRoute])]),
      ]),
    ]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
  await router.load();
  const mounted = render(<RouterProvider router={router} />);
  return { mounted, router };
};

const openFileInInspector = () => {
  useInspectorTabsStore.getState().openFile({
    id: fieldId,
    entityId,
    label: "Engagement letter",
    fileName: "Engagement letter.pdf",
    mimeType: "application/pdf",
    pdfFileId: null,
    workspaceId,
  });
};

const filesViewHref = `/workspaces/${workspaceId}/${filesViewId}?folder=${folderId}`;

afterEach(async () => {
  await act(async () => cleanup());
  useInspectorTabsStore.setState({
    tabs: [],
    groups: [],
    groupAssignments: {},
    collapsedGroupIds: [],
    activeId: null,
    minimized: false,
    reviveSuggestion: null,
  });
});

afterAll(async () => {
  await unregisterDomEnvironment();
});

describe("leaving the full document view", () => {
  test("returns to the Files view it was expanded from, file still inspected", async () => {
    openFileInInspector();
    const { mounted, router } = await mountMatter(filesViewHref);

    fireEvent.click(mounted.getByTestId("expand"));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(
        `/workspaces/${workspaceId}/${filesViewId}/document`,
      ),
    );
    expect(router.state.location.search).toMatchObject({
      entity: entityId,
      field: fieldId,
    });
    await waitFor(() => expect(inspectedFile().metadataLane).toBe("expanded"));

    fireEvent.click(mounted.getByTestId("back-to-peek"));
    await waitFor(() => expect(router.state.location.href).toBe(filesViewHref));
    await mounted.findByTestId("files-view");
    expect(useInspectorTabsStore.getState().activeId).toBe(fieldId);
    expect(inspectedFile().metadataLane).toBe("closed");
  });

  test("browser Back lands on the same Files view as the back control", async () => {
    openFileInInspector();
    const { mounted, router } = await mountMatter(filesViewHref);

    fireEvent.click(mounted.getByTestId("expand"));
    await mounted.findByTestId("document-view");

    await act(async () => router.history.back());
    await waitFor(() => expect(router.state.location.href).toBe(filesViewHref));
    await mounted.findByTestId("files-view");
    expect(useInspectorTabsStore.getState().activeId).toBe(fieldId);
  });

  test("without a history entry, returns to the view named in the document URL", async () => {
    openFileInInspector();
    const { mounted, router } = await mountMatter(
      `/workspaces/${workspaceId}/${filesViewId}/document?entity=${entityId}&field=${fieldId}`,
    );
    expect(router.history.canGoBack()).toBe(false);

    fireEvent.click(mounted.getByTestId("back-to-peek"));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(
        `/workspaces/${workspaceId}/${filesViewId}`,
      ),
    );
    await mounted.findByTestId("files-view");
    expect(useInspectorTabsStore.getState().activeId).toBe(fieldId);
  });
});
