import { createFileRoute } from "@tanstack/react-router";

import { redirectToSchema } from "@/lib/redirect";
import { routeSearchSchema } from "@/route-search-params";

import { ReauthenticatePage } from "./-reauth.page";
import { ReauthenticatePending } from "./-reauth.pending";

export const Route = createFileRoute("/auth/reauth")({
  validateSearch: routeSearchSchema({ redirectTo: redirectToSchema }),
  component: ReauthenticatePage,
  pendingComponent: ReauthenticatePending,
});
