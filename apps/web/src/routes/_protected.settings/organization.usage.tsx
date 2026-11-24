import { createFileRoute } from "@tanstack/react-router";

import { env } from "@/env";
import { getAnalytics } from "@/lib/analytics/provider";
import { pageTitle } from "@/lib/page-title";
import { prefetchRouteQuery } from "@/lib/react-query";
import { routePresentation } from "@/routes/-route-presentation";
import { usagePoliciesOptions } from "@/routes/_protected.settings/organization/-queries/usage-policies";

import { UsageSettingsPage } from "./-organization.usage.page";
import { UsagePending } from "./-organization.usage.pending";

export const Route = createFileRoute("/_protected/settings/organization/usage")(
  {
    staticData: {
      presentation: routePresentation({
        type: "label",
        labelKey: "admin.planAndUsage",
        to: "/settings/organization/usage",
      }),
    },
    loader: async ({ context }) => {
      // The catalog exists only behind the usage flag; with the flag off
      // this route must issue exactly the requests it does today (the
      // route-smoke network baseline pins them).
      if (env.VITE_FEATURE_USAGE) {
        await prefetchRouteQuery(
          context.queryClient,
          usagePoliciesOptions,
          (error: unknown) => {
            getAnalytics().captureError(error, {
              fingerprintKey: "admin.usage.loader:failure",
              scope: {
                type: "request",
                method: "GET",
                routeTemplate: "/_protected/settings/organization/usage",
              },
            });
          },
        );
      }
    },
    component: UsageSettingsPage,
    pendingComponent: UsagePending,
    head: () => ({ meta: [{ title: pageTitle("admin.planAndUsage") }] }),
  },
);
