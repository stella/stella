import { createFileRoute, Navigate } from "@tanstack/react-router";

import { routePresentation } from "@/lib/route-presentation";

export const Route = createFileRoute("/_protected/settings/")({
  staticData: { presentation: routePresentation({ type: "inherit" }) },
  component: () => <Navigate replace to="/settings/account/profile" />,
});
