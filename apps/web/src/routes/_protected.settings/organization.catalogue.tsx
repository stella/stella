import { Suspense } from "react";

import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { CatalogueBrowser } from "@/routes/_protected.settings/-components/catalogue/catalogue-browser";
import { SettingsPageHeader } from "@/routes/_protected.settings/-components/settings-page-header";

export const Route = createFileRoute(
  "/_protected/settings/organization/catalogue",
)({
  component: CataloguePage,
});

const protectedRouteApi = getRouteApi("/_protected");

function CataloguePage() {
  const t = useTranslations();
  const organizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });

  return (
    <>
      <SettingsPageHeader
        description={t("settings.organization.catalogueDescription")}
        title={t("settings.organization.catalogue")}
      />
      <Suspense fallback={null}>
        <CatalogueBrowser mode="settings" organizationId={organizationId} />
      </Suspense>
    </>
  );
}
