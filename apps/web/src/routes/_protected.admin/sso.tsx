import { createFileRoute } from "@tanstack/react-router";

import { redirectRouteComponent } from "@/routes/-route-pending-view";

export const Route = createFileRoute("/_protected/admin/sso")({
  component: redirectRouteComponent({ to: "/settings/organization/sso" }),
});
