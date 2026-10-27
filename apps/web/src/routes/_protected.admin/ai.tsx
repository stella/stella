import { createFileRoute } from "@tanstack/react-router";

import { useTimeBillingPreviewEnabled } from "@/hooks/use-time-billing-preview";
import { AIConfigCard } from "@/routes/_protected.admin/-components/organization/ai-config-card";
import { BillingDraftsCard } from "@/routes/_protected.admin/-components/organization/billing-drafts-card";

export const Route = createFileRoute("/_protected/admin/ai")({
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
