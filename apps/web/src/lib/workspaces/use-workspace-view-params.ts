import { useMatch } from "@tanstack/react-router";

import { resolveWorkspaceViewParams } from "@/lib/workspaces/view-params.logic";

/** The matter view on screen, or `undefined` off any matter view. Callers
 * render in shared chrome as well as under the view route. */
export const useCurrentWorkspaceView = () => {
  const workspaceId = useMatch({
    from: "/_protected/workspaces/$workspaceId/$viewId",
    shouldThrow: false,
    select: (match) => match.params.workspaceId,
  });
  const viewId = useMatch({
    from: "/_protected/workspaces/$workspaceId/$viewId",
    shouldThrow: false,
    select: (match) => match.params.viewId,
  });
  return workspaceId === undefined || viewId === undefined
    ? undefined
    : { workspaceId, viewId };
};

/** The `$workspaceId/$viewId` params a navigation into `targetWorkspaceId`
 * opens under: the view on screen when it belongs to that matter, else the
 * matter's default view. */
export const useWorkspaceViewParams = (targetWorkspaceId: string) =>
  resolveWorkspaceViewParams(targetWorkspaceId, useCurrentWorkspaceView());
