import type { QueryClient } from "@tanstack/react-query";

import { cachedRoleGrants } from "@/lib/cached-permissions.logic";
import { callerFeatureEnabled } from "@/lib/organization/feature-access/access.logic";
import { CALLER_FEATURE } from "@/lib/organization/feature-access/surfaces";
import type { WorkspaceView } from "@/lib/types";
import { viewsOptions } from "@/lib/workspaces/queries/views";
import {
  selectAvailableWorkspaceView,
  selectAvailableWorkspaceViews,
} from "@/lib/workspaces/queries/views.logic";
import { switcherViews } from "@/lib/workspaces/view-layout";
import { optionalOrganizationSettingsOptions } from "@/queries/organization-settings";

/**
 * Overview, AVT and correspondence do not show the matter's entities through
 * filters, sorts and columns, so the toolbar that edits those has nothing to
 * act on.
 */
export const hasViewToolbar = (view: WorkspaceView): boolean =>
  view.layout.type !== "overview" &&
  view.layout.type !== "avt" &&
  view.layout.type !== "correspondence";

export type CachedViewChrome = {
  activeView: WorkspaceView;
  /** The views the switcher shows, in its order. */
  views: readonly WorkspaceView[];
  canCreateView: boolean;
  /** Whether the active tab carries an action menu. */
  hasViewActions: boolean;
};

type CachedViewChromeInput = {
  workspaceId: string;
  viewId: string;
  user: { activeOrganizationId: string | null; id: string } | null;
};

const hasSettledData = (
  queryClient: QueryClient,
  queryKey: readonly unknown[],
) => queryClient.getQueryState(queryKey)?.error === null;

/**
 * What the view tabs row shows before the route's data has loaded, read from
 * what the cache already holds: the views (a matter opened before), the role
 * and the organization's features. Nothing is fetched; without cached views
 * there is no row to draw yet, and a role or feature not in the cache counts
 * as not granted, as the loaded switcher counts it while they load.
 */
export const cachedViewChrome = (
  queryClient: QueryClient,
  { workspaceId, viewId, user }: CachedViewChromeInput,
): CachedViewChrome | null => {
  const cachedViews = queryClient.getQueryData(
    viewsOptions(workspaceId).queryKey,
  );
  if (cachedViews === undefined) {
    return null;
  }
  const activeView = selectAvailableWorkspaceView(cachedViews, viewId);
  if (activeView === undefined) {
    return null;
  }

  const settingsKey = optionalOrganizationSettingsOptions({
    organizationId: user?.activeOrganizationId ?? null,
    userId: user?.id ?? "",
  }).queryKey;
  const settings = queryClient.getQueryData(settingsKey);
  const avtEnabled =
    settings !== undefined &&
    hasSettledData(queryClient, settingsKey) &&
    callerFeatureEnabled(settings, CALLER_FEATURE.verification);

  const granted = (permission: "create" | "update" | "delete") =>
    cachedRoleGrants(queryClient, { view: [permission] });
  const canCreateView = granted("create");

  return {
    activeView,
    views: switcherViews(
      selectAvailableWorkspaceViews(cachedViews),
      avtEnabled,
    ),
    canCreateView,
    hasViewActions: canCreateView || granted("update") || granted("delete"),
  };
};
