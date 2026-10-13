import { createFileRoute, redirect } from "@tanstack/react-router";
import { Result } from "better-result";
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
    const previewPromise = isTimeBillingPreviewEnabled(context.queryClient, {
      userId: context.user.id,
      organizationId: context.user.activeOrganizationId,
    });
    // Capture preview failure so the role decision still takes precedence.
    const [role, preview] = await Promise.all([
      ensureRouteQueryData(context.queryClient, roleOptions),
      Result.tryPromise({
        try: () => previewPromise,
        catch: (cause) => cause,
      }),
    ]);
    if (Result.isError(preview)) {
      throw preview.error;
    }
    if (
      !isBillingSettingsAccessible({
        previewEnabled: preview.value,
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
