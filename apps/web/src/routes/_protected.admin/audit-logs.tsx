import { createFileRoute } from "@tanstack/react-router";

import { redirectRouteComponent } from "@/routes/-route-pending-view";

export const Route = createFileRoute("/_protected/admin/audit-logs")({
  component: redirectRouteComponent({
    to: "/settings/organization/audit-logs",
  }),
});
