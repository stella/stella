import { useTimeBillingPreviewEnabled } from "@/hooks/use-time-billing-preview";
import { AIConfigCard } from "@/routes/_protected.settings/organization/-components/organization/ai-config-card";
import { BillingDraftsCard } from "@/routes/_protected.settings/organization/-components/organization/billing-drafts-card";
import { LocalRunApprovalCeilingCard } from "@/routes/_protected.settings/organization/-components/organization/local-run-approval-ceiling-card";

import { AIConfigPageShell } from "./-organization.ai.pending";

export function AIConfigPage() {
  const timeBillingEnabled = useTimeBillingPreviewEnabled();
  return (
    <AIConfigPageShell
      billingDrafts={timeBillingEnabled ? <BillingDraftsCard /> : undefined}
      localRunApprovalCeiling={<LocalRunApprovalCeilingCard />}
      providerSettings={<AIConfigCard />}
    />
  );
}
