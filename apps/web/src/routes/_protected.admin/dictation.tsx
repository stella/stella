import { createFileRoute } from "@tanstack/react-router";

import { redirectRouteComponent } from "@/routes/-route-pending-view";

export const Route = createFileRoute("/_protected/admin/dictation")({
  component: redirectRouteComponent({
    to: "/settings/organization/dictation",
  }),
});
