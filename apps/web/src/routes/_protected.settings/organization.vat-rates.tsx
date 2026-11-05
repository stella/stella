import { createFileRoute, redirect } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { isTimeBillingPreviewEnabled } from "@/hooks/use-time-billing-preview";
import { getAnalytics } from "@/lib/analytics/provider";
import { roleOptions } from "@/lib/auth-queries";
import { isBillingSettingsAccessible } from "@/lib/organization/billing-settings.logic";
import { vatRatesOptions } from "@/lib/organization/vat-rates";
import { pageTitle } from "@/lib/page-title";
import {
  ensureRouteQueryData,
  prefetchNonCriticalInfiniteQuery,
} from "@/lib/react-query";
import { routePresentation } from "@/routes/-route-presentation";
import { SettingsPageHeader } from "@/routes/_protected.settings/-components/settings-page-header";
import { VatRatesCard } from "@/routes/_protected.settings/organization/-components/organization/vat-rates-card";

export const Route = createFileRoute(
  "/_protected/settings/organization/vat-rates",
)({
  staticData: {
    organizationSettingsAdmission: "time-billing",
    presentation: routePresentation({
      type: "label",
      labelKey: "billing.vatRates.title",
      to: "/settings/organization/vat-rates",
    }),
  },
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
            routeTemplate: "/_protected/settings/organization/vat-rates",
          },
        }),
    );
  },
  // Start the list with the route, not after the card mounts. A failure
  // stays in the query, so the card shows its own refusal and retry.
  head: () => ({ meta: [{ title: pageTitle("billing.vatRates.title") }] }),
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
