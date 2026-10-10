import { createFileRoute, redirect } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { isTimeBillingPreviewEnabled } from "@/hooks/use-time-billing-preview";
import { getAnalytics } from "@/lib/analytics/provider";
import { roleOptions } from "@/lib/auth-queries";
import { vatRatesOptions } from "@/lib/organization/vat-rates";
import {
  ensureRouteQueryData,
  prefetchNonCriticalInfiniteQuery,
} from "@/lib/react-query";
import { isBillingSettingsAccessible } from "@/routes/_protected.settings/-components/organization/billing-settings.logic";
import { VatRatesCard } from "@/routes/_protected.settings/-components/organization/vat-rates-card";
import { SettingsPageHeader } from "@/routes/_protected.settings/-components/settings-page-header";

export const Route = createFileRoute(
  "/_protected/settings/organization/vat-rates",
)({
  beforeLoad: async ({ context }) => {
    const role = await ensureRouteQueryData(context.queryClient, roleOptions);
    if (
      !isBillingSettingsAccessible({
        previewEnabled: await isTimeBillingPreviewEnabled(context.queryClient, {
          userId: context.user.id,
          organizationId: context.user.activeOrganizationId,
        }),
        role,
      })
    ) {
      redirect({
        to: "/settings/organization/members",
        replace: true,
        throw: true,
      });
    }
  },
  // Start the list with the route, not after the card mounts. A failure
  // stays in the query, so the card shows its own refusal and retry.
  loader: async ({ context }) => {
    await prefetchNonCriticalInfiniteQuery(
      context.queryClient,
      vatRatesOptions(context.user.activeOrganizationId),
      (error) => getAnalytics().captureError(error),
    );
  },
  component: VatRateSettingsPage,
});

function VatRateSettingsPage() {
  const t = useTranslations();
  return (
    <>
      <SettingsPageHeader title={t("billing.vatRates.title")} />
      <VatRatesCard />
    </>
  );
}
