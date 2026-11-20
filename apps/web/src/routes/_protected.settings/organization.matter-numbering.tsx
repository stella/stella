import { createFileRoute } from "@tanstack/react-router";

import { pageTitle } from "@/lib/page-title";
import { routePresentation } from "@/routes/-route-presentation";

import { MatterNumberingPage } from "./-organization.matter-numbering.page";
import { MatterNumberingPending } from "./-organization.matter-numbering.pending";

export const Route = createFileRoute(
  "/_protected/settings/organization/matter-numbering",
)({
  staticData: {
    presentation: routePresentation({
      type: "label",
      labelKey: "settings.organization.matterNumbering",
      to: "/settings/organization/matter-numbering",
    }),
  },
  head: () => ({
    meta: [{ title: pageTitle("settings.organization.matterNumbering") }],
  }),
  component: MatterNumberingPage,
  pendingComponent: MatterNumberingPending,
});
