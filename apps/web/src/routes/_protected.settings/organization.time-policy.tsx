import { createFileRoute, redirect } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { isTimeBillingRouteEnabled } from "@/hooks/use-time-billing-preview";
import { pageTitle } from "@/lib/page-title";
import { ensureRouteQueryData } from "@/lib/react-query";
import { organizationSettingsOptions } from "@/queries/organization-settings";
import { routePresentation } from "@/routes/-route-presentation";
import { SettingsPageHeader } from "@/routes/_protected.settings/-components/settings-page-header";
import { TimePolicyCard } from "@/routes/_protected.settings/organization/-components/organization/time-policy-card";

export const Route = createFileRoute(
  "/_protected/settings/organization/time-policy",
)({
  staticData: {
    presentation: routePresentation({
      type: "label",
      labelKey: "settings.organization.timePolicy.title",
      to: "/settings/organization/time-policy",
    }),
  },
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
  head: () => ({
    meta: [{ title: pageTitle("settings.organization.timePolicy.title") }],
  }),
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
