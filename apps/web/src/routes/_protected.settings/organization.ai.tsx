import { createFileRoute } from "@tanstack/react-router";

import { useTimeBillingPreviewEnabled } from "@/hooks/use-time-billing-preview";
import { aiConfigOptions } from "@/lib/organization/ai-config-queries";
import { pageTitle } from "@/lib/page-title";
import { ensureRouteQueryData } from "@/lib/react-query";
import { routePresentation } from "@/routes/-route-presentation";
import { AIConfigCard } from "@/routes/_protected.settings/organization/-components/organization/ai-config-card";
import { BillingDraftsCard } from "@/routes/_protected.settings/organization/-components/organization/billing-drafts-card";
import { LocalRunApprovalCeilingCard } from "@/routes/_protected.settings/organization/-components/organization/local-run-approval-ceiling-card";

export const Route = createFileRoute("/_protected/settings/organization/ai")({
  staticData: {
    presentation: routePresentation({
      type: "label",
      labelKey: "admin.modelsAndProviders",
      to: "/settings/organization/ai",
    }),
  },
  // The provider settings render complete on the first paint, so the cards
  // below them never move when the settings arrive.
  loader: async ({ context }) => {
    await ensureRouteQueryData(
      context.queryClient,
      aiConfigOptions({ organizationId: context.user.activeOrganizationId }),
    );
  },
  head: () => ({ meta: [{ title: pageTitle("admin.modelsAndProviders") }] }),
  component: AIConfigPage,
});

function AIConfigPage() {
  const timeBillingEnabled = useTimeBillingPreviewEnabled();
  return (
    <>
      <AIConfigCard />
      <LocalRunApprovalCeilingCard />
      {timeBillingEnabled && <BillingDraftsCard />}
    </>
  );
}
