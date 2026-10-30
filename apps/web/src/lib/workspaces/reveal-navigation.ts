import type { QueryClient } from "@tanstack/react-query";
import type { RegisteredRouter, useNavigate } from "@tanstack/react-router";

import { getAnalytics } from "@/lib/analytics/provider";
import { ensureRouteQueryData } from "@/lib/react-query";
import type { WorkspaceView } from "@/lib/types";
import { viewsOptions } from "@/lib/workspaces/queries/views";
import { getCurrentWorkspaceView } from "@/lib/workspaces/use-workspace-view-params";
import { resolveWorkspaceViewParams } from "@/lib/workspaces/view-params.logic";
import type { WorkspaceViewParams } from "@/lib/workspaces/view-params.logic";

type Navigate = ReturnType<typeof useNavigate>;

type RevealTargetInput = {
  /** Row to reveal in the tree. */
  entityId: string;
  /** Folder to scope the current view into when the matter has no tree. */
  fallbackFolderId: string | null;
  targetWorkspaceId: string;
};

/** An entity opens in the matter's file tree, preferring one whose filters
 * cannot hide it: the current tree, else the first tree, unfiltered ones
 * first. Only a matter without a tree falls back to the current view scoped
 * into `fallbackFolderId`. */
export const getWorkspaceRevealTarget = ({
  currentView,
  entityId,
  fallbackFolderId,
  targetWorkspaceId,
  views,
}: RevealTargetInput & {
  currentView: WorkspaceViewParams | undefined;
  views: readonly {
    id: string;
    layout: Pick<WorkspaceView["layout"], "type" | "filters">;
  }[];
}) => {
  const viewParams = resolveWorkspaceViewParams(targetWorkspaceId, currentView);
  const filesystemViews = views.filter(
    (view) => view.layout.type === "filesystem",
  );
  const unfilteredViews = filesystemViews.filter(
    (view) => view.layout.filters.length === 0,
  );
  const pick = (candidates: typeof filesystemViews) =>
    candidates.find((view) => view.id === viewParams.viewId) ??
    candidates.at(0);
  const filesystemView = pick(unfilteredViews) ?? pick(filesystemViews);

  if (filesystemView) {
    return {
      to: "/workspaces/$workspaceId/$viewId" as const,
      params: { viewId: filesystemView.id, workspaceId: targetWorkspaceId },
      search: { reveal: entityId },
    };
  }

  return {
    to: "/workspaces/$workspaceId/$viewId" as const,
    params: viewParams,
    search: fallbackFolderId === null ? {} : { folder: fallbackFolderId },
  };
};

type NavigateToWorkspaceRevealOptions = RevealTargetInput & {
  navigate: Navigate;
  queryClient: QueryClient;
  /** Where the view on screen is read once the matter's views load. */
  router: Pick<RegisteredRouter, "state">;
};

export const navigateToWorkspaceReveal = async ({
  navigate,
  queryClient,
  router,
  ...target
}: NavigateToWorkspaceRevealOptions) => {
  // A failed views lookup must not swallow the click: record it and fall
  // back to the folder-scoped target, which needs no view list.
  const views = await ensureRouteQueryData(
    queryClient,
    viewsOptions(target.targetWorkspaceId),
  ).catch((error: unknown) => {
    getAnalytics().captureError(error, {
      fingerprintKey: "navigateToWorkspaceReveal:failure",
      scope: {
        type: "handler",
        handlerId: "navigateToWorkspaceReveal:failure",
      },
    });
    return [];
  });
  await navigate(
    getWorkspaceRevealTarget({
      ...target,
      currentView: getCurrentWorkspaceView(router.state.matches),
      views,
    }),
  );
};

/** A folder link reveals the folder; without a tree it scopes into it. */
export const navigateToWorkspaceFolder = async ({
  folderId,
  ...rest
}: Omit<NavigateToWorkspaceRevealOptions, "entityId" | "fallbackFolderId"> & {
  folderId: string;
}) => {
  await navigateToWorkspaceReveal({
    ...rest,
    entityId: folderId,
    fallbackFolderId: folderId,
  });
};
