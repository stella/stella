import { createFileRoute } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { ensureRouteQueryData } from "@/lib/react-query";
import { SsoCard } from "@/routes/_protected.settings/-components/organization/sso-card";
import { SettingsPageHeader } from "@/routes/_protected.settings/-components/settings-page-header";
import { ssoConnectionOptions } from "@/routes/_protected.settings/-queries/sso";

export const Route = createFileRoute("/_protected/settings/organization/sso")({
  loader: async ({ context }) => {
    await ensureRouteQueryData(
      context.queryClient,
      ssoConnectionOptions({
        organizationId: context.user.activeOrganizationId,
      }),
    );
  },
  component: SsoSettingsPage,
});

function SsoSettingsPage() {
  const t = useTranslations();
  const activeOrganizationId = Route.useRouteContext({
    select: (context) => context.user.activeOrganizationId,
  });

  return (
    <>
      <SettingsPageHeader
        description={t("settings.organization.sso.description")}
        title={t("settings.organization.sso.title")}
      />
      <SsoCard organizationId={activeOrganizationId} />
    </>
  );
}
