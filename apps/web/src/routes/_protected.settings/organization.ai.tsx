import { createFileRoute } from "@tanstack/react-router";

import { pageTitle } from "@/lib/page-title";
import { routePresentation } from "@/routes/-route-presentation";
import { AIConfigCard } from "@/routes/_protected.settings/organization/-components/organization/ai-config-card";

export const Route = createFileRoute("/_protected/settings/organization/ai")({
  staticData: {
    presentation: routePresentation({
      type: "label",
      labelKey: "admin.modelsAndProviders",
      to: "/settings/organization/ai",
    }),
  },
  head: () => ({ meta: [{ title: pageTitle("admin.modelsAndProviders") }] }),
  component: AIConfigPage,
});

function AIConfigPage() {
  return <AIConfigCard />;
}
