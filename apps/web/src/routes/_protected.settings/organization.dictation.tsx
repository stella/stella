import { createFileRoute } from "@tanstack/react-router";

import { pageTitle } from "@/lib/page-title";
import { routePresentation } from "@/routes/-route-presentation";

import { OrganizationDictationPage } from "./-organization.dictation.page";
import { DictationPending } from "./-organization.dictation.pending";

export const Route = createFileRoute(
  "/_protected/settings/organization/dictation",
)({
  staticData: {
    presentation: routePresentation({
      type: "label",
      labelKey: "settings.organization.dictation.title",
      to: "/settings/organization/dictation",
    }),
  },
  head: () => ({
    meta: [{ title: pageTitle("settings.organization.dictation.title") }],
  }),
  component: OrganizationDictationPage,
  pendingComponent: DictationPending,
});
