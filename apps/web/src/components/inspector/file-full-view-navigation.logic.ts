const MATTER_OVERVIEW_VIEW_ID = "all";

type MatterViewParams = { workspaceId: string; viewId: string };

/** The matter view a file's full document view opens under, which is also
 * where leaving it lands when there is no in-app history entry to go back
 * to. The view on screen keeps that role when the file belongs to its
 * matter; a file from another matter opens under that matter's overview,
 * since the current view id means nothing there. */
export const resolveFullViewOriginView = (
  fileWorkspaceId: string,
  currentView: MatterViewParams | undefined,
): MatterViewParams =>
  currentView?.workspaceId === fileWorkspaceId
    ? { workspaceId: currentView.workspaceId, viewId: currentView.viewId }
    : { workspaceId: fileWorkspaceId, viewId: MATTER_OVERVIEW_VIEW_ID };
