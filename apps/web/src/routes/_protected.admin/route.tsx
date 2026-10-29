import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";

import {
  organizationSettingsDestination,
  organizationSettingsSearchSchema,
} from "@/routes/-organization-settings-route";

export const Route = createFileRoute("/_protected/admin")({
  validateSearch: organizationSettingsSearchSchema,
  beforeLoad: ({ location, search }) => {
    redirect({
      ...organizationSettingsDestination(location.pathname, search),
      replace: true,
      throw: true,
    });
  },
  component: Outlet,
});
