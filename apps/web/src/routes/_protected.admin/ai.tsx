import { createFileRoute } from "@tanstack/react-router";

import { pageTitle } from "@/lib/page-title";
import { routePresentation } from "@/lib/route-presentation";
import { AIConfigCard } from "@/routes/_protected.admin/-components/organization/ai-config-card";

export const Route = createFileRoute("/_protected/admin/ai")({
  staticData: {
    presentation: routePresentation({
      type: "label",
      labelKey: "admin.modelsAndProviders",
      to: "/admin/ai",
    }),
  },
  head: () => ({ meta: [{ title: pageTitle("admin.modelsAndProviders") }] }),
  component: AIConfigPage,
});

function AIConfigPage() {
  return <AIConfigCard />;
}
