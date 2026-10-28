import { createFileRoute } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { SettingsPageHeader } from "@/components/settings-page-header";
import { pageTitle } from "@/lib/page-title";
import { routePresentation } from "@/routes/-route-presentation";
import { DocumentTypesCard } from "@/routes/_protected.admin/-components/organization/document-types-card";

export const Route = createFileRoute("/_protected/admin/document-types")({
  staticData: {
    presentation: routePresentation({
      type: "label",
      labelKey: "settings.organization.documentTypes.title",
      to: "/admin/document-types",
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
