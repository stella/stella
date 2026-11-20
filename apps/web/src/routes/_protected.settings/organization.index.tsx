import { createFileRoute, redirect } from "@tanstack/react-router";

import { organizationSettingsDestination } from "@/routes/-organization-settings-route";
import { redirectRouteComponent } from "@/routes/-route-pending-view";

export const Route = createFileRoute("/_protected/settings/organization/")({
  beforeLoad: ({ location, search }) => {
    redirect({
      ...organizationSettingsDestination(location.pathname, search),
      replace: true,
      throw: true,
    });
  },
  // Names the page the redirect leads to, so a cold load draws its shape.
  component: redirectRouteComponent({ to: "/settings/organization/general" }),
});
