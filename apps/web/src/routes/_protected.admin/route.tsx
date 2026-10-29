import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";

import { legacyAdminSettingsDestination } from "@/routes/_protected.admin/-route-cutover";

export const Route = createFileRoute("/_protected/admin")({
  beforeLoad: ({ location }) => {
    redirect({
      to: legacyAdminSettingsDestination(location.pathname),
      replace: true,
      throw: true,
    });
  },
  component: Outlet,
});
