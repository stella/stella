import { createFileRoute } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { DocumentTypesCard } from "@/routes/_protected.settings/-components/organization/document-types-card";
import { SettingsPageHeader } from "@/routes/_protected.settings/-components/settings-page-header";

export const Route = createFileRoute(
  "/_protected/settings/organization/document-types",
)({
  component: OrganizationDocumentTypesPage,
});

function OrganizationDocumentTypesPage() {
  const t = useTranslations();

  return (
    <>
      <SettingsPageHeader
        description={t("settings.organization.documentTypes.description")}
        title={t("settings.organization.documentTypes.title")}
      />
      <DocumentTypesCard />
    </>
  );
}
