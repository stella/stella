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

type RevealTargetInput = {
  /** Row to reveal in the tree; null opens the tree at its root. */
  entityId: string | null;
  /** Folder to scope the current view into when the matter has no tree. */
  fallbackFolderId: string | null;
  pathname: string;
  targetWorkspaceId: string;
};

/** An entity opens in the matter's file tree, preferring one whose filters
 * cannot hide it: the current tree, else the first tree, unfiltered ones
 * first. Only a matter without a tree falls back to the current view scoped
 * into `fallbackFolderId`. */
export const getWorkspaceRevealTarget = ({
  entityId,
  fallbackFolderId,
  pathname,
  targetWorkspaceId,
  views,
}: RevealTargetInput & {
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
      search: entityId === null ? {} : { reveal: entityId },
    };
  }

  return {
    to: "/workspaces/$workspaceId/$viewId" as const,
    params: {
      viewId: currentViewId ?? DEFAULT_WORKSPACE_VIEW_ID,
      workspaceId: targetWorkspaceId,
    },
    search: fallbackFolderId === null ? {} : { folder: fallbackFolderId },
  };
};

export const navigateToWorkspaceReveal = async ({
  navigate,
  queryClient,
  ...target
}: RevealTargetInput & {
  navigate: Navigate;
  queryClient: QueryClient;
}) => {
  // A failed views lookup must not swallow the click: record it and fall
  // back to the folder-scoped target, which needs no view list.
  const views = await ensureRouteQueryData(
    queryClient,
    viewsOptions(target.targetWorkspaceId),
  ).catch((error: unknown) => {
    getAnalytics().captureError(error);
    return [];
  });
  await navigate(getWorkspaceRevealTarget({ ...target, views }));
};

/** A folder link reveals the folder; without a tree it scopes into it. */
export const navigateToWorkspaceFolder = async ({
  folderId,
  ...rest
}: Omit<RevealTargetInput, "entityId" | "fallbackFolderId"> & {
  folderId: string;
  navigate: Navigate;
  queryClient: QueryClient;
}) => {
  await navigateToWorkspaceReveal({
    ...rest,
    entityId: folderId,
    fallbackFolderId: folderId,
  });
};
