import { createFileRoute, Outlet } from "@tanstack/react-router";

import { LeafPendingView } from "@/routes/-route-pending-view";
import { routePresentation } from "@/routes/-route-presentation";

export const Route = createFileRoute("/_protected/workspaces")({
  staticData: {
    presentation: routePresentation({
      type: "label",
      labelKey: "common.matters",
      to: "/workspaces",
    }),
  },
  component: MattersLayout,
  // A layout: its pending view is the page it leads to.
  pendingComponent: LeafPendingView,
});

/** The matters section: the list, or one matter, under the section's label. */
function MattersLayout() {
  return <Outlet />;
}
