import { createFileRoute, redirect } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { isTimeBillingPreviewEnabled } from "@/hooks/use-time-billing-preview";
import { roleOptions } from "@/lib/auth-queries";
import { ensureRouteQueryData } from "@/lib/react-query";
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
        previewEnabled: isTimeBillingPreviewEnabled(),
        role,
      })
    ) {
      throw redirect({ to: "/settings/organization/members", replace: true });
    }
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
