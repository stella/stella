import { createFileRoute, Outlet } from "@tanstack/react-router";

import { routePresentation } from "@/lib/route-presentation";

export const Route = createFileRoute("/_protected/workspaces")({
  staticData: {
    presentation: routePresentation({
      type: "label",
      labelKey: "common.matters",
      to: "/workspaces",
    }),
  },
  component: Outlet,
});
