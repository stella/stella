import { getRouteApi } from "@tanstack/react-router";

import { CompanyRegistryPreview } from "@/components/company-registry-preview";
import { DefaultNotFoundComponent } from "@/components/route-components";
import { isLookupRegistry } from "@/components/templates/template-field-manifest";
import { KnowledgeMemberOnly } from "@/routes/knowledge/-knowledge-member-only";
import {
  CompanyFormatPending,
  CompanyFormatShell,
} from "@/routes/knowledge/-member/company-format.pending";

const companyFormatRouteApi = getRouteApi(
  "/knowledge/company-formats/$registry/$companyId",
);

const CompanyFormat = () => {
  const { companyId, registry } = companyFormatRouteApi.useParams({
    select: (params) => ({
      companyId: params.companyId,
      registry: params.registry,
    }),
  });
  if (!isLookupRegistry(registry)) {
    return <DefaultNotFoundComponent />;
  }
  return (
    <CompanyFormatShell>
      <CompanyRegistryPreview
        companyId={companyId}
        initialSettingsVisibility="open"
        registry={registry}
      />
    </CompanyFormatShell>
  );
};

/** A company's registry record with the organization's formats for it. */
export const CompanyFormatPage = () => (
  <KnowledgeMemberOnly pending={<CompanyFormatPending />}>
    {(organizationId) => <CompanyFormat key={organizationId} />}
  </KnowledgeMemberOnly>
);
