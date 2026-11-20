import { createFileRoute } from "@tanstack/react-router";

import { redirectRouteComponent } from "@/routes/-route-pending-view";

export const Route = createFileRoute(
  "/_protected/settings/organization/catalogue",
)({
  component: redirectRouteComponent({ to: "/knowledge/tools" }),
});
