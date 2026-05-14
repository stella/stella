import { createFileRoute } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { AnonymizationDenyListCard } from "@/routes/_protected.settings/-components/organization/anonymization-deny-list-card";
import { SettingsPageHeader } from "@/routes/_protected.settings/-components/settings-page-header";

export const Route = createFileRoute(
  "/_protected/settings/organization/anonymization",
)({
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
