import { createFileRoute } from "@tanstack/react-router";

import { pageTitle } from "@/lib/page-title";
import { routePresentation } from "@/routes/-route-presentation";

import { OrganizationAnonymizationPage } from "./-organization.anonymization.page";
import { AnonymizationPending } from "./-organization.anonymization.pending";

export const Route = createFileRoute(
  "/_protected/settings/organization/anonymization",
)({
  staticData: {
    presentation: routePresentation({
      type: "label",
      labelKey: "settings.organization.anonymization.title",
      to: "/settings/organization/anonymization",
    }),
  },
  head: () => ({
    meta: [{ title: pageTitle("settings.organization.anonymization.title") }],
  }),
  component: OrganizationAnonymizationPage,
  pendingComponent: AnonymizationPending,
});
