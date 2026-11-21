import { createFileRoute } from "@tanstack/react-router";

import { sessionsOptions } from "@/lib/account/queries";
import { sessionSignInsOptions } from "@/lib/account/session-sign-ins";
import { sessionOptions } from "@/lib/auth-queries";
import { pageTitle } from "@/lib/page-title";
import { ensureRouteQueryData } from "@/lib/react-query";
import { resourceQueryOptions } from "@/lib/workspace-realtime";
import { routePresentation } from "@/routes/-route-presentation";

import { securitySearchSchema } from "./-account.security.logic";
import { SecurityPage } from "./-account.security.page";
import { SecurityPending } from "./-account.security.pending";

export const Route = createFileRoute("/_protected/settings/account/security")({
  validateSearch: securitySearchSchema,
  // The devices are on the page when it lands, so a `#` link and the
  // review card find their target without waiting for a second request.
  loader: async ({ context }) => {
    await Promise.all([
      ensureRouteQueryData(
        context.queryClient,
        resourceQueryOptions({ ...sessionOptions }, { type: "independent" }),
      ),
      ensureRouteQueryData(
        context.queryClient,
        sessionsOptions(context.user.id),
      ),
      ensureRouteQueryData(
        context.queryClient,
        sessionSignInsOptions(context.user.id),
      ),
    ]);
  },
  staticData: {
    presentation: routePresentation({
      type: "label",
      labelKey: "settings.account.security.title",
      to: "/settings/account/security",
    }),
  },
  component: SecurityPage,
  pendingComponent: SecurityPending,
  head: () => ({
    meta: [{ title: pageTitle("settings.account.security.title") }],
  }),
});
