import { createFileRoute, redirect } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { isTimeBillingPreviewEnabled } from "@/hooks/use-time-billing-preview";
import { roleOptions } from "@/lib/auth-queries";
import { ensureRouteQueryData } from "@/lib/react-query";
import { isBillingSettingsAccessible } from "@/routes/_protected.settings/-components/organization/billing-settings.logic";
import { SellerProfilesCard } from "@/routes/_protected.settings/-components/organization/seller-profiles-card";
import { SettingsPageHeader } from "@/routes/_protected.settings/-components/settings-page-header";

export const Route = createFileRoute(
  "/_protected/settings/organization/billing",
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
