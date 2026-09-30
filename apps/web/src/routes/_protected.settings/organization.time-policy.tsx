import { createFileRoute, redirect } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { isTimeBillingRouteEnabled } from "@/hooks/use-time-billing-preview";
import { ensureRouteQueryData } from "@/lib/react-query";
import { organizationSettingsOptions } from "@/queries/organization-settings";
import { TimePolicyCard } from "@/routes/_protected.settings/-components/organization/time-policy-card";
import { SettingsPageHeader } from "@/routes/_protected.settings/-components/settings-page-header";

export const Route = createFileRoute(
  "/_protected/settings/organization/time-policy",
)({
  beforeLoad: () => {
    if (!isTimeBillingRouteEnabled()) {
      redirect({
        to: "/settings/organization/members",
        replace: true,
        throw: true,
      });
    }
  },
  loader: async ({ context }) => {
    await ensureRouteQueryData(
      context.queryClient,
      organizationSettingsOptions(context.user.activeOrganizationId),
    );
  },
  component: TimePolicyPage,
});

function TimePolicyPage() {
  const t = useTranslations();
  return (
    <>
      <SettingsPageHeader
        title={t("settings.organization.timePolicy.title")}
        description={t("settings.organization.timePolicy.description")}
      />
      <TimePolicyCard />
    </>
  );
}
