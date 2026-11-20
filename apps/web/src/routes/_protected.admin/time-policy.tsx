import { createFileRoute } from "@tanstack/react-router";

import { redirectRouteComponent } from "@/routes/-route-pending-view";

export const Route = createFileRoute("/_protected/admin/time-policy")({
  component: redirectRouteComponent({
    to: "/settings/organization/time-policy",
  }),
});
