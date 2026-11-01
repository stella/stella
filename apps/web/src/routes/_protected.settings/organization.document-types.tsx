import { createFileRoute } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { pageTitle } from "@/lib/page-title";
import { routePresentation } from "@/routes/-route-presentation";
import { SettingsPageHeader } from "@/routes/_protected.settings/-components/settings-page-header";
import { DocumentTypesCard } from "@/routes/_protected.settings/organization/-components/organization/document-types-card";

export const Route = createFileRoute(
  "/_protected/settings/organization/document-types",
)({
  staticData: {
    presentation: routePresentation({
      type: "label",
      labelKey: "settings.organization.documentTypes.title",
      to: "/settings/organization/document-types",
    }),
  },
  head: () => ({
    meta: [{ title: pageTitle("settings.organization.documentTypes.title") }],
  }),
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
