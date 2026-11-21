import { createFileRoute } from "@tanstack/react-router";

import { sessionOptions } from "@/lib/auth-queries";
import { pageTitle } from "@/lib/page-title";
import { ensureRouteQueryData } from "@/lib/react-query";
import { routePresentation } from "@/routes/-route-presentation";

import { ProfilePage } from "./-account.profile.page";
import { ProfilePending } from "./-account.profile.pending";

export const Route = createFileRoute("/_protected/settings/account/profile")({
  loader: async ({ context }) => {
    // Prime the session query the page suspends on so the fetch starts during
    // navigation instead of after the component mounts and suspends.
    await ensureRouteQueryData(context.queryClient, sessionOptions);
  },
  staticData: {
    presentation: routePresentation({
      type: "label",
      labelKey: "common.profile",
      to: "/settings/account/profile",
    }),
  },
  component: ProfilePage,
  pendingComponent: ProfilePending,
  head: () => ({ meta: [{ title: pageTitle("common.profile") }] }),
});
