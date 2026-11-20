import type { QueryClient } from "@tanstack/react-query";

import { newestCachedData } from "@/components/pending-cache-reads.logic";
import { cachedRoleGrants } from "@/lib/organization/cached-permissions.logic";
import { callerFeatureEnabled } from "@/lib/organization/feature-access/access.logic";
import { CALLER_FEATURE } from "@/lib/organization/feature-access/surfaces";
import { organizationSettingsQueryRoot } from "@/lib/resource-query-roots.logic";
import type { WorkspaceView } from "@/lib/types";
import {
  type CachedWorkspaceView,
  selectAvailableWorkspaceView,
  selectAvailableWorkspaceViews,
  viewsRootKey,
} from "@/lib/workspaces/queries/views.logic";
import { switcherViews } from "@/lib/workspaces/view-layout";
import type { OrganizationSettings } from "@/queries/organization-settings";

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
};

/** The matter's views as the cache holds them, or `undefined`. */
const cachedWorkspaceViews = (
  queryClient: QueryClient,
  workspaceId: string,
): CachedWorkspaceView[] | undefined =>
  newestCachedData(
    queryClient,
    queryClient.getQueriesData<CachedWorkspaceView[]>({
      queryKey: viewsRootKey(workspaceId),
    }),
  );

const cachedAvtEnabled = (queryClient: QueryClient): boolean =>
  callerFeatureEnabled(
    newestCachedData(
      queryClient,
      queryClient.getQueriesData<OrganizationSettings>({
        queryKey: organizationSettingsQueryRoot(),
      }),
    ),
    CALLER_FEATURE.verification,
  );

/**
 * What the view tabs row shows before the route's data has loaded, read from
 * what the cache already holds: the views (a matter opened before), the role
 * and the organization's features. Nothing is fetched; without cached views
 * there is no row to draw yet, and a role or feature not in the cache counts
 * as not granted, as the loaded switcher counts it while they load. It reads
 * every one of them by key, so a loading view that calls it loads no query.
 */
export const cachedViewChrome = (
  queryClient: QueryClient,
  input: CachedViewChromeInput,
): CachedViewChrome | null => {
  const cachedViews = cachedWorkspaceViews(queryClient, input.workspaceId);
  const activeView =
    cachedViews === undefined
      ? undefined
      : selectAvailableWorkspaceView(cachedViews, input.viewId);
  if (cachedViews === undefined || activeView === undefined) {
    return null;
  }

  const granted = (permission: "create" | "update" | "delete") =>
    cachedRoleGrants(queryClient, { view: [permission] });
  const canCreateView = granted("create");

  return {
    activeView,
    views: switcherViews(
      selectAvailableWorkspaceViews(cachedViews),
      cachedAvtEnabled(queryClient),
    ),
    canCreateView,
    hasViewActions: canCreateView || granted("update") || granted("delete"),
  };
};
