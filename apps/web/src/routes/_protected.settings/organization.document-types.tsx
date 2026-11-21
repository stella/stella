import { createFileRoute } from "@tanstack/react-router";

import { pageTitle } from "@/lib/page-title";
import { routePresentation } from "@/routes/-route-presentation";

import { OrganizationDocumentTypesPage } from "./-organization.document-types.page";
import { DocumentTypesPending } from "./-organization.document-types.pending";

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
  pendingComponent: DocumentTypesPending,
});
