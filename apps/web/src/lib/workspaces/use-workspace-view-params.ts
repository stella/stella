import type { RegisteredRouter } from "@tanstack/react-router";
import { useMatch } from "@tanstack/react-router";

import { resolveWorkspaceViewParams } from "@/lib/workspaces/view-params.logic";

// The route that names a matter view. Its match, not the URL path, says which
// view is on screen: a matter's other pages (reports, correspondence) sit at
// the same depth and match their own routes.
const WORKSPACE_VIEW_ROUTE_ID = "/_protected/workspaces/$workspaceId/$viewId";

/** The matter view on screen, or `undefined` off any matter view. Callers
 * render in shared chrome as well as under the view route. */
export const useCurrentWorkspaceView = () => {
  const workspaceId = useMatch({
    from: WORKSPACE_VIEW_ROUTE_ID,
    shouldThrow: false,
    select: (match) => match.params.workspaceId,
  });
  const viewId = useMatch({
    from: WORKSPACE_VIEW_ROUTE_ID,
    shouldThrow: false,
    select: (match) => match.params.viewId,
  });
  return workspaceId === undefined || viewId === undefined
    ? undefined
    : { workspaceId, viewId };
};

/** The matter view on screen when an event handler runs, read from the
 * router's current matches without subscribing the component to them. */
export const getCurrentWorkspaceView = (
  router: Pick<RegisteredRouter, "state">,
) => {
  for (const match of router.state.matches) {
    if (match.routeId === WORKSPACE_VIEW_ROUTE_ID) {
      return {
        workspaceId: match.params.workspaceId,
        viewId: match.params.viewId,
      };
    }
  }
  return undefined;
};

/** The `$workspaceId/$viewId` params a navigation into `targetWorkspaceId`
 * opens under: the view on screen when it belongs to that matter, else the
 * matter's default view. */
export const useWorkspaceViewParams = (targetWorkspaceId: string) =>
  resolveWorkspaceViewParams(targetWorkspaceId, useCurrentWorkspaceView());
