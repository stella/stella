import { DocumentTypesCard } from "@/routes/_protected.settings/organization/-components/organization/document-types-card";

import { DocumentTypesShell } from "./-organization.document-types.pending";

export function OrganizationDocumentTypesPage() {
  return (
    <DocumentTypesShell>
      <DocumentTypesCard />
    </DocumentTypesShell>
  );
}
