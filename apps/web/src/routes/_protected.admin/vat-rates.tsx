import { createFileRoute, redirect } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { SettingsPageHeader } from "@/components/settings-page-header";
import { isTimeBillingPreviewEnabled } from "@/hooks/use-time-billing-preview";
import { getAnalytics } from "@/lib/analytics/provider";
import { roleOptions } from "@/lib/auth-queries";
import { isBillingSettingsAccessible } from "@/lib/organization/billing-settings.logic";
import { vatRatesOptions } from "@/lib/organization/vat-rates";
import {
  ensureRouteQueryData,
  prefetchNonCriticalInfiniteQuery,
} from "@/lib/react-query";
import { VatRatesCard } from "@/routes/_protected.admin/-components/organization/vat-rates-card";

export const Route = createFileRoute("/_protected/admin/vat-rates")({
  staticData: { organizationSettingsAdmission: "time-billing" },
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
        to: "/admin/members",
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
      (error) =>
        getAnalytics().captureError(error, {
          fingerprintKey: "admin.vat-rates.loader:failure",
          scope: {
            type: "request",
            method: "GET",
            routeTemplate: "/_protected/admin/vat-rates",
          },
        }),
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
