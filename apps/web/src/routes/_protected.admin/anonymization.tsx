import { createFileRoute } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { SettingsPageHeader } from "@/components/settings-page-header";
import { AnonymizationDenyListCard } from "@/routes/_protected.admin/-components/organization/anonymization-deny-list-card";

export const Route = createFileRoute("/_protected/admin/anonymization")({
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
