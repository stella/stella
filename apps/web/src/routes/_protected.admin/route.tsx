import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";

import {
  organizationSettingsDestination,
  organizationSettingsSearchSchema,
} from "@/routes/-organization-settings-route";
import { LeafPendingView } from "@/routes/-route-pending-view";

export const Route = createFileRoute("/_protected/admin")({
  validateSearch: organizationSettingsSearchSchema,
  beforeLoad: ({ location, search }) => {
    redirect({
      ...organizationSettingsDestination(location.pathname, search),
      replace: true,
      throw: true,
    });
  },
  component: LegacyAdminLayout,
  // Every legacy admin page redirects to its organization settings page, and
  // each child names that target, so while the redirect runs this draws the
  // target page's pending view rather than a generic block.
  pendingComponent: LeafPendingView,
});

function LegacyAdminLayout() {
  return <Outlet />;
}
