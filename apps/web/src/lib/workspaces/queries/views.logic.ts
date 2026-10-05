import type { UnavailableWorkspaceView } from "@stll/api-contract";

import type { WorkspaceView } from "@/lib/types";

export type CachedWorkspaceView = WorkspaceView | UnavailableWorkspaceView;

export const isWorkspaceViewAvailable = (
  view: CachedWorkspaceView,
): view is WorkspaceView => !("eligibility" in view);

/** The raw cache retains every identity; consumers receive usable layouts. */
export const selectAvailableWorkspaceViews = (
  views: CachedWorkspaceView[],
): WorkspaceView[] => views.filter(isWorkspaceViewAvailable);

export const selectAvailableWorkspaceView = (
  views: CachedWorkspaceView[],
  viewId: string,
): WorkspaceView | undefined => {
  const available = selectAvailableWorkspaceViews(views);
  return available.find((view) => view.id === viewId) ?? available.at(0);
};

const VIEWS_QUERY_ROOT = "views";

export const viewsRootKey = (workspaceId: string) => [
  VIEWS_QUERY_ROOT,
  workspaceId,
];

/** The matter whose views list `queryKey` holds, or `null` for any other key. */
export const viewsQueryWorkspaceId = (queryKey: unknown): string | null => {
  if (!Array.isArray(queryKey)) {
    return null;
  }
  const root: unknown = queryKey.at(0);
  const workspaceId: unknown = queryKey.at(1);
  return root === VIEWS_QUERY_ROOT && typeof workspaceId === "string"
    ? workspaceId
    : null;
};
