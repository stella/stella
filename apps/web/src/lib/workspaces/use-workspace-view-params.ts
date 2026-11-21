import type { MakeRouteMatchUnion } from "@tanstack/react-router";
import { useMatch } from "@tanstack/react-router";

import { resolveWorkspaceViewParams } from "@/lib/workspaces/view-params.logic";

// The routes that name a matter view and its document page. Their matches,
// not the URL path, say which page is on screen: a matter's other pages
// (reports, correspondence) sit at the same depth and match their own routes.
const WORKSPACE_VIEW_ROUTE_ID = "/_protected/workspaces/$workspaceId/$viewId";
const WORKSPACE_DOCUMENT_ROUTE_ID =
  "/_protected/workspaces/$workspaceId/$viewId/document";

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

/** The matter view on screen in `matches`: `router.state.matches` when an
 * event handler runs (read without subscribing the component), or a route's
 * `beforeLoad` matches. */
export const getCurrentWorkspaceView = (
  matches: readonly MakeRouteMatchUnion[],
) => {
  for (const match of matches) {
    if (match.routeId === WORKSPACE_VIEW_ROUTE_ID) {
      return {
        workspaceId: match.params.workspaceId,
        viewId: match.params.viewId,
      };
    }
  }
  return undefined;
};

/** The matter document page on screen: its matter and the entity and field
 * it shows, or `undefined` off the document page. Declared, not inferred: the
 * `$viewId` route's `beforeLoad` returns it as context, and route context is
 * part of the match types it is read from. */
export type CurrentWorkspaceDocument =
  | {
      workspaceId: string;
      entityId: string | undefined;
      fieldId: string | undefined;
    }
  | undefined;

/** The matter document page in `matches`. */
export const getCurrentWorkspaceDocument = (
  matches: readonly MakeRouteMatchUnion[],
): CurrentWorkspaceDocument => {
  for (const match of matches) {
    if (match.routeId === WORKSPACE_DOCUMENT_ROUTE_ID) {
      return {
        workspaceId: match.params.workspaceId,
        entityId: match.search.entity,
        fieldId: match.search.field,
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
