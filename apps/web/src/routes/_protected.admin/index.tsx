import { createFileRoute, Navigate } from "@tanstack/react-router";

import { routePresentation } from "@/routes/-route-presentation";

export const Route = createFileRoute("/_protected/admin/")({
  staticData: { presentation: routePresentation({ type: "inherit" }) },
  component: () => <Navigate replace to="/admin/general" />,
});
