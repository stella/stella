import { createFileRoute } from "@tanstack/react-router";

import { AIConfigCard } from "@/routes/_protected.settings/-components/organization/ai-config-card";
import { BillingDraftsCard } from "@/routes/_protected.settings/-components/organization/billing-drafts-card";

export const Route = createFileRoute("/_protected/settings/organization/ai")({
  component: AIConfigPage,
});

function AIConfigPage() {
  return (
    <>
      <AIConfigCard />
      <BillingDraftsCard />
    </>
  );
}
