import { createFileRoute, Outlet } from "@tanstack/react-router";

import { routePresentation } from "@/lib/route-presentation";

export const Route = createFileRoute("/_protected/contacts")({
  staticData: {
    presentation: routePresentation({
      type: "label",
      labelKey: "navigation.contacts",
      to: "/contacts",
    }),
  },
  component: Outlet,
});
