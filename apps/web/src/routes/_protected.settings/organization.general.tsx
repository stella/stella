import { createFileRoute } from "@tanstack/react-router";

import { organizationOptions } from "@/lib/organization/queries";
import { pageTitle } from "@/lib/page-title";
import { ensureRouteQueryData } from "@/lib/react-query";
import { routePresentation } from "@/routes/-route-presentation";

import { OrganizationGeneralPage } from "./-organization.general.page";
import { OrganizationGeneralPending } from "./-organization.general.pending";

export const Route = createFileRoute(
  "/_protected/settings/organization/general",
)({
  staticData: {
    presentation: routePresentation({
      type: "label",
      labelKey: "admin.general",
      to: "/settings/organization/general",
    }),
  },
  loader: async ({ context }) => {
    await ensureRouteQueryData(
      context.queryClient,
      organizationOptions(context.user.activeOrganizationId),
    );
  },
  head: () => ({ meta: [{ title: pageTitle("admin.general") }] }),
  component: OrganizationGeneralPage,
  pendingComponent: OrganizationGeneralPending,
});
