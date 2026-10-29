import { createFileRoute, redirect } from "@tanstack/react-router";

import { organizationSettingsDestination } from "@/routes/_protected.admin/-route-cutover";

export const Route = createFileRoute("/_protected/settings/organization/")({
  beforeLoad: ({ location, search }) => {
    redirect({
      ...organizationSettingsDestination(location.pathname, search),
      replace: true,
      throw: true,
    });
  },
});
