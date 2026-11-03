import type { ComponentType } from "react";

import type { QueryClient } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from "@tanstack/react-router";

import type { WorkspaceView } from "@/lib/types";
import { viewsOptions } from "@/lib/workspaces/queries/views";

export const TEST_MATTER_ID = "019a0000-0000-7000-8000-000000000501";
export const TEST_FILES_VIEW_ID = "019a0000-0000-7000-8000-000000000502";
const TEST_OTHER_FILES_VIEW_ID = "019a0000-0000-7000-8000-000000000503";
export const TEST_FOLDER_ID = "019a0000-0000-7000-8000-000000000504";

const fileTree = (id: string, name: string, position: number) =>
  ({
    id,
    version: 1,
    name,
    position,
    createdAt: "2026-01-01T00:00:00.000Z",
    layout: {
      type: "filesystem",
      version: 1,
      filters: [],
      sorts: [],
      hiddenProperties: [],
      calculations: [],
    },
  }) satisfies WorkspaceView;

/** Seeds two unfiltered trees, so a reveal that ignores the view on screen
 * lands on the first one instead of the second. */
export const seedTestMatterTrees = (queryClient: QueryClient) => {
  queryClient.setQueryData(viewsOptions(TEST_MATTER_ID).queryKey, [
    fileTree(TEST_FILES_VIEW_ID, "Files", 0),
    fileTree(TEST_OTHER_FILES_VIEW_ID, "Other files", 1),
  ]);
};

/** The second tree's document page, where the view on screen is the parent
 * match of the page that renders. */
export const TEST_OTHER_TREE_DOCUMENT_PATH = `/workspaces/${TEST_MATTER_ID}/${TEST_OTHER_FILES_VIEW_ID}/document?entity=e`;

/**
 * A memory router with the matter routes that decide which view is on screen:
 * the `$viewId` route and its document, the matter pages at the same depth
 * that name no view (reports, correspondence), and a page outside any matter.
 * `Shell` renders above every page, as app chrome does.
 */
export const createMatterViewTestRouter = async (
  initialEntry: string,
  Shell: ComponentType,
) => {
  const root = createRootRoute({
    component: () => (
      <>
        <Shell />
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
  const router = createRouter({
    routeTree: root.addChildren([
      protectedRoute.addChildren([
        workspace.addChildren([
          view.addChildren([
            createRoute({ getParentRoute: () => view, path: "document" }),
          ]),
          createRoute({
            getParentRoute: () => workspace,
            path: "reports/$exportId",
          }),
          createRoute({
            getParentRoute: () => workspace,
            path: "correspondence/$correspondenceId",
          }),
        ]),
        createRoute({ getParentRoute: () => protectedRoute, path: "chat" }),
      ]),
    ]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
    isServer: false,
  });
  await router.load();
  return router;
};

/** Where a folder reveal from the second tree must land: that tree, with the
 * folder revealed. */
export const EXPECTED_OTHER_TREE_REVEAL = {
  pathname: `/workspaces/${TEST_MATTER_ID}/${TEST_OTHER_FILES_VIEW_ID}`,
  search: { reveal: TEST_FOLDER_ID },
};
