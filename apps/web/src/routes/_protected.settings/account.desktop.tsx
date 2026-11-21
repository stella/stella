import { createFileRoute } from "@tanstack/react-router";

import { pageTitle } from "@/lib/page-title";
import { routePresentation } from "@/routes/-route-presentation";

import { DesktopPage } from "./-account.desktop.page";
import { DesktopPending } from "./-account.desktop.pending";

export const Route = createFileRoute("/_protected/settings/account/desktop")({
  head: () => ({ meta: [{ title: pageTitle("settings.account.desktop") }] }),
  staticData: {
    presentation: routePresentation({
      type: "label",
      labelKey: "settings.account.desktop",
      to: "/settings/account/desktop",
    }),
  },
  component: DesktopPage,
  pendingComponent: DesktopPending,
});
