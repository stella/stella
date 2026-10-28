import { createFileRoute, redirect } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { SettingsPageHeader } from "@/components/settings-page-header";
import { isTimeBillingPreviewEnabled } from "@/hooks/use-time-billing-preview";
import { roleOptions } from "@/lib/auth-queries";
import { isBillingSettingsAccessible } from "@/lib/organization/billing-settings.logic";
import { pageTitle } from "@/lib/page-title";
import { ensureRouteQueryData } from "@/lib/react-query";
import { SellerProfilesCard } from "@/routes/_protected.admin/-components/organization/seller-profiles-card";

export const Route = createFileRoute("/_protected/admin/billing")({
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
  staticData: { organizationSettingsAdmission: "time-billing" },
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
