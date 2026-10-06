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
  beforeLoad: async ({ context }) => {
    if (
      !(await isTimeBillingRouteEnabled(context.queryClient, {
        userId: context.user.id,
        organizationId: context.user.activeOrganizationId,
      }))
    ) {
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
      organizationSettingsOptions({
        organizationId: context.user.activeOrganizationId,
        userId: context.user.id,
      }),
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
