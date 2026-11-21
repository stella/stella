import { createFileRoute } from "@tanstack/react-router";

import { sessionsOptions } from "@/lib/account/queries";
import { sessionSignInsOptions } from "@/lib/account/session-sign-ins";
import { getAnalytics } from "@/lib/analytics/provider";
import { sessionOptions } from "@/lib/auth-queries";
import { pageTitle } from "@/lib/page-title";
import { ensureRouteQueryData, prefetchRouteQuery } from "@/lib/react-query";
import { resourceQueryOptions } from "@/lib/workspace-realtime";
import { routePresentation } from "@/routes/-route-presentation";

import { securitySearchSchema } from "./-account.security-search.logic";
import { SecurityPage } from "./-account.security.page";
import { SecurityPending } from "./-account.security.pending";

export const Route = createFileRoute("/_protected/settings/account/security")({
  validateSearch: securitySearchSchema,
  // The devices are on the page when it lands, so a `#` link and the
  // review card find their target without waiting for a second request. A
  // failed device read never fails the route: the device sections offer
  // their own retry, and sign-in methods, two-factor and the export stay.
  loader: async ({ context }) => {
    const onPrefetchError = (error: unknown) => {
      getAnalytics().captureError(error, {
        fingerprintKey: "settings.security.loader.onPrefetchError:failure",
        scope: {
          type: "request",
          method: "GET",
          routeTemplate: "/_protected/settings/account/security",
        },
      });
    };
    await Promise.all([
      ensureRouteQueryData(
        context.queryClient,
        resourceQueryOptions({ ...sessionOptions }, { type: "independent" }),
      ),
      prefetchRouteQuery(
        context.queryClient,
        sessionsOptions(context.user.id),
        onPrefetchError,
      ),
      prefetchRouteQuery(
        context.queryClient,
        sessionSignInsOptions(context.user.id),
        onPrefetchError,
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
