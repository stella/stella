import { createFileRoute } from "@tanstack/react-router";

import { CompanyRegistryPreview } from "@/components/company-registry-preview";
import { DefaultNotFoundComponent } from "@/components/route-components";
import { isLookupRegistry } from "@/components/templates/template-field-manifest";

export const Route = createFileRoute(
  "/_protected/knowledge/company-formats/$registry/$companyId",
)({
  component: CompanyFormatPage,
});

function CompanyFormatPage() {
  const { companyId, registry } = Route.useParams({
    select: (params) => ({
      companyId: params.companyId,
      registry: params.registry,
    }),
  });
  if (!isLookupRegistry(registry)) {
    return <DefaultNotFoundComponent />;
  }
  return (
    <div className="mx-auto min-h-0 w-full max-w-3xl flex-1">
      <CompanyRegistryPreview
        companyId={companyId}
        initialSettingsVisibility="open"
        registry={registry}
      />
    </div>
  );
}
