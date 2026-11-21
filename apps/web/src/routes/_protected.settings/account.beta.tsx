import { createFileRoute, redirect } from "@tanstack/react-router";

import { betaFeaturesAvailable } from "@/lib/beta-features";
import { pageTitle } from "@/lib/page-title";
import { routePresentation } from "@/routes/-route-presentation";

import { BetaFeaturesPage } from "./-account.beta.page";
import { BetaPending } from "./-account.beta.pending";

export const Route = createFileRoute("/_protected/settings/account/beta")({
  beforeLoad: () => {
    if (!betaFeaturesAvailable()) {
      throw redirect({ to: "/settings/account/profile" });
    }
  },
  staticData: {
    presentation: routePresentation({
      type: "label",
      labelKey: "settings.account.beta",
      to: "/settings/account/beta",
    }),
  },
  head: () => ({ meta: [{ title: pageTitle("settings.account.beta") }] }),
  component: BetaFeaturesPage,
  pendingComponent: BetaPending,
});
