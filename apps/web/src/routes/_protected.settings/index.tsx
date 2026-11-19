import { createFileRoute } from "@tanstack/react-router";

import { redirectRouteComponent } from "@/routes/-route-pending-view";
import { routePresentation } from "@/routes/-route-presentation";

export const Route = createFileRoute("/_protected/settings/")({
  staticData: { presentation: routePresentation({ type: "inherit" }) },
  component: redirectRouteComponent({ to: "/settings/account/profile" }),
});
