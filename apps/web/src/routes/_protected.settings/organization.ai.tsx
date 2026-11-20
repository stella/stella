import { createFileRoute } from "@tanstack/react-router";

import { getAnalytics } from "@/lib/analytics/provider";
import {
  aiAvailabilityOptions,
  aiConfigOptions,
} from "@/lib/organization/ai-config-queries";
import { pageTitle } from "@/lib/page-title";
import { ensureRouteQueryData, prefetchRouteQuery } from "@/lib/react-query";
import { organizationSettingsOptions } from "@/queries/organization-settings";
import { routePresentation } from "@/routes/-route-presentation";

import { AIConfigPage } from "./-organization.ai.page";
import { AIConfigPending } from "./-organization.ai.pending";

export const Route = createFileRoute("/_protected/settings/organization/ai")({
  staticData: {
    presentation: routePresentation({
      type: "label",
      labelKey: "admin.modelsAndProviders",
      to: "/settings/organization/ai",
    }),
  },
  // The provider settings and the organization settings behind the
  // instructions and toggle cards render complete on the first paint, so no
  // card moves when its data arrives. A failed organization-settings read
  // leaves each card its own retry.
  loader: async ({ context }) => {
    await Promise.all([
      ensureRouteQueryData(
        context.queryClient,
        aiConfigOptions({ organizationId: context.user.activeOrganizationId }),
      ),
      // Whether the organization needs a key at all; the providers' line
      // stays generic until it is read.
      prefetchRouteQuery(
        context.queryClient,
        aiAvailabilityOptions({
          organizationId: context.user.activeOrganizationId,
        }),
        (error) => {
          getAnalytics().captureError(error, {
            fingerprintKey: "admin.ai.loader:availability-failure",
            scope: {
              type: "request",
              method: "GET",
              routeTemplate: "/_protected/settings/organization/ai",
            },
          });
        },
      ),
      prefetchRouteQuery(
        context.queryClient,
        organizationSettingsOptions({
          organizationId: context.user.activeOrganizationId,
          userId: context.user.id,
        }),
        (error) => {
          getAnalytics().captureError(error, {
            fingerprintKey: "admin.ai.loader:failure",
            scope: {
              type: "request",
              method: "GET",
              routeTemplate: "/_protected/settings/organization/ai",
            },
          });
        },
      ),
    ]);
  },
  head: () => ({ meta: [{ title: pageTitle("admin.modelsAndProviders") }] }),
  component: AIConfigPage,
  pendingComponent: AIConfigPending,
});
