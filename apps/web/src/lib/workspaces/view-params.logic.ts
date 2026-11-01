/** The `$viewId` slug that names no view: the matter route resolves it to the
 * matter's first available view, its Overview unless the views were
 * reordered. A navigation that keeps the reader in a matter passes the view on
 * screen through `resolveWorkspaceViewParams`; this slug is for destinations
 * with no view to keep (a newly created matter, a page outside any view). */
export const DEFAULT_WORKSPACE_VIEW_ID = "all";

const VIEW_UUID_PATTERN =
  /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu;

/** Whether a path segment can be a `$viewId`: a view's UUID or the default
 * slug. Rejects the sibling segments of a matter path (`reports`,
 * `correspondence`, a stale doubled `workspaces`). */
export const isWorkspaceViewId = (segment: string): boolean =>
  segment === DEFAULT_WORKSPACE_VIEW_ID || VIEW_UUID_PATTERN.test(segment);

export type WorkspaceViewParams = { workspaceId: string; viewId: string };

/** The view a navigation into `targetWorkspaceId` opens under. The view on
 * screen keeps that role when it belongs to the target matter, so leaving a
 * document returns there even without a history entry; another matter opens
 * under its default view, since the current view id means nothing there. */
export const resolveWorkspaceViewParams = (
  targetWorkspaceId: string,
  currentView: WorkspaceViewParams | undefined,
): WorkspaceViewParams =>
  currentView?.workspaceId === targetWorkspaceId
    ? { workspaceId: currentView.workspaceId, viewId: currentView.viewId }
    : { workspaceId: targetWorkspaceId, viewId: DEFAULT_WORKSPACE_VIEW_ID };
