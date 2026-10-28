import { createFileRoute } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { SettingsPageHeader } from "@/components/settings-page-header";
import { pageTitle } from "@/lib/page-title";
import { routePresentation } from "@/lib/route-presentation";
import { AnonymizationDenyListCard } from "@/routes/_protected.admin/-components/organization/anonymization-deny-list-card";

export const Route = createFileRoute("/_protected/admin/anonymization")({
  staticData: {
    presentation: routePresentation({
      type: "label",
      labelKey: "settings.organization.anonymization.title",
      to: "/admin/anonymization",
    }),
  },
  head: () => ({
    meta: [{ title: pageTitle("settings.organization.anonymization.title") }],
  }),
  component: OrganizationAnonymizationPage,
});

function OrganizationAnonymizationPage() {
  const t = useTranslations();

  return (
    <>
      <SettingsPageHeader
        description={t("settings.organization.anonymization.description")}
        title={t("settings.organization.anonymization.title")}
      />
      <AnonymizationDenyListCard />
    </>
  );
}
