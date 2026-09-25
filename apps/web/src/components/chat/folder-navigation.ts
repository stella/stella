import type { QueryClient } from "@tanstack/react-query";
import type { useNavigate } from "@tanstack/react-router";

import { getAnalytics } from "@/lib/analytics/provider";
import { ensureRouteQueryData } from "@/lib/react-query";
import type { WorkspaceView } from "@/lib/types";
import { viewsOptions } from "@/lib/workspaces/queries/views";

type Navigate = ReturnType<typeof useNavigate>;
const DEFAULT_WORKSPACE_VIEW_ID = "all";

export const getCurrentWorkspaceViewId = (
  pathname: string,
  workspaceId: string,
) => {
  const prefix = `/workspaces/${workspaceId}/`;
  if (!pathname.startsWith(prefix)) {
    return null;
  }

  const viewId = pathname.slice(prefix.length).split("/").at(0);
  return viewId || null;
};

/** A folder opens in the matter's file tree, preferring one whose filters
 * cannot hide it: the current tree, else the first tree, unfiltered ones
 * first. Only a matter without a tree falls back to the current view scoped
 * into the folder. */
export const getWorkspaceFolderNavigationTarget = ({
  folderId,
  pathname,
  targetWorkspaceId,
  views,
}: {
  folderId: string;
  pathname: string;
  targetWorkspaceId: string;
  views: readonly {
    id: string;
    layout: Pick<WorkspaceView["layout"], "type" | "filters">;
  }[];
}) => {
  const currentViewId = getCurrentWorkspaceViewId(pathname, targetWorkspaceId);
  const filesystemViews = views.filter(
    (view) => view.layout.type === "filesystem",
  );
  const unfilteredViews = filesystemViews.filter(
    (view) => view.layout.filters.length === 0,
  );
  const pick = (candidates: typeof filesystemViews) =>
    candidates.find((view) => view.id === currentViewId) ?? candidates.at(0);
  const filesystemView = pick(unfilteredViews) ?? pick(filesystemViews);

  if (filesystemView) {
    return {
      to: "/workspaces/$workspaceId/$viewId" as const,
      params: { viewId: filesystemView.id, workspaceId: targetWorkspaceId },
      search: { reveal: folderId },
    };
  }

  return {
    to: "/workspaces/$workspaceId/$viewId" as const,
    params: {
      viewId: currentViewId ?? DEFAULT_WORKSPACE_VIEW_ID,
      workspaceId: targetWorkspaceId,
    },
    search: { folder: folderId },
  };
};

export const navigateToWorkspaceFolder = async ({
  folderId,
  navigate,
  pathname,
  queryClient,
  targetWorkspaceId,
}: {
  folderId: string;
  navigate: Navigate;
  pathname: string;
  queryClient: QueryClient;
  targetWorkspaceId: string;
}) => {
  // A failed views lookup must not swallow the click: record it and fall
  // back to the folder-scoped target, which needs no view list.
  const views = await ensureRouteQueryData(
    queryClient,
    viewsOptions(targetWorkspaceId),
  ).catch((error: unknown) => {
    getAnalytics().captureError(error);
    return [];
  });
  await navigate(
    getWorkspaceFolderNavigationTarget({
      folderId,
      pathname,
      targetWorkspaceId,
      views,
    }),
  );
};
