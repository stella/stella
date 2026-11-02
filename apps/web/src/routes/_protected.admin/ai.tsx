import { createFileRoute } from "@tanstack/react-router";

import { useTimeBillingPreviewEnabled } from "@/hooks/use-time-billing-preview";
import { pageTitle } from "@/lib/page-title";
import { routePresentation } from "@/routes/-route-presentation";
import { AIConfigCard } from "@/routes/_protected.admin/-components/organization/ai-config-card";
import { BillingDraftsCard } from "@/routes/_protected.admin/-components/organization/billing-drafts-card";

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
  const timeBillingEnabled = useTimeBillingPreviewEnabled();
  return (
    <>
      <AIConfigCard />
      {timeBillingEnabled && <BillingDraftsCard />}
    </>
  );
}
