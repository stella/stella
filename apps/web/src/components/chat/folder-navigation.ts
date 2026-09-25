import type { QueryClient } from "@tanstack/react-query";
import type { useNavigate } from "@tanstack/react-router";

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

/** A folder opens in the matter's file tree: the current view when it is
 * already a tree, else the first tree view. Only a matter without one falls
 * back to the current view scoped into the folder. */
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
    layout: Pick<WorkspaceView["layout"], "type">;
  }[];
}) => {
  const currentViewId = getCurrentWorkspaceViewId(pathname, targetWorkspaceId);
  const filesystemViews = views.filter(
    (view) => view.layout.type === "filesystem",
  );
  const filesystemView =
    filesystemViews.find((view) => view.id === currentViewId) ??
    filesystemViews.at(0);

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
  const views = await ensureRouteQueryData(
    queryClient,
    viewsOptions(targetWorkspaceId),
  );
  await navigate(
    getWorkspaceFolderNavigationTarget({
      folderId,
      pathname,
      targetWorkspaceId,
      views,
    }),
  );
};
