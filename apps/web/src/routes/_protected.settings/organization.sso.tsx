import { createFileRoute } from "@tanstack/react-router";

import { pageTitle } from "@/lib/page-title";
import { routePresentation } from "@/routes/-route-presentation";

import { OrganizationSsoPage } from "./-organization.sso.page";
import { OrganizationSsoPending } from "./-organization.sso.pending";

export const Route = createFileRoute("/_protected/settings/organization/sso")({
  staticData: {
    presentation: routePresentation({
      type: "label",
      labelKey: "settings.organization.sso.title",
      to: "/settings/organization/sso",
    }),
  },
  head: () => ({
    meta: [{ title: pageTitle("settings.organization.sso.title") }],
  }),
  component: OrganizationSsoPage,
  pendingComponent: OrganizationSsoPending,
});
