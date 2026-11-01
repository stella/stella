import { createFileRoute, redirect } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { isTimeBillingPreviewEnabled } from "@/hooks/use-time-billing-preview";
import { roleOptions } from "@/lib/auth-queries";
import { isBillingSettingsAccessible } from "@/lib/organization/billing-settings.logic";
import { pageTitle } from "@/lib/page-title";
import { ensureRouteQueryData } from "@/lib/react-query";
import { routePresentation } from "@/routes/-route-presentation";
import { SettingsPageHeader } from "@/routes/_protected.settings/-components/settings-page-header";
import { SellerProfilesCard } from "@/routes/_protected.settings/organization/-components/organization/seller-profiles-card";

export const Route = createFileRoute(
  "/_protected/settings/organization/billing",
)({
  staticData: {
    organizationSettingsAdmission: "time-billing",
    presentation: routePresentation({
      type: "label",
      labelKey: "admin.billingProfiles",
      to: "/settings/organization/billing",
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
  head: () => ({ meta: [{ title: pageTitle("admin.billingProfiles") }] }),
  component: BillingSettingsPage,
});

function BillingSettingsPage() {
  const t = useTranslations();
  return (
    <>
      <SettingsPageHeader title={t("billing.settingsTitle")} />
      <SellerProfilesCard />
    </>
  );
}
