import { lazy, Suspense } from "react";

import { createFileRoute } from "@tanstack/react-router";

import { TemplateListSkeleton } from "@/features/knowledge/views/templates/template-list-view";
import { KnowledgeAudienceGate } from "@/routes/knowledge/-knowledge-audience-gate";
import { PublicTemplatesCatalogue } from "@/routes/knowledge/-public/public-templates-catalogue";
import { templatesSearchSchema } from "@/routes/knowledge/-templates-search";

// The organization's library loads only for a member, after the session is
// known; a visitor without an account never evaluates it.
const LazyMemberTemplatesPage = lazy(async () => {
  const module =
    await import("@/routes/knowledge/-member/member-templates-page");
  return { default: module.MemberTemplatesPage };
});

export const Route = createFileRoute("/knowledge/templates")({
  validateSearch: templatesSearchSchema,
  component: TemplatesSection,
});

function TemplatesSection() {
  return (
    <KnowledgeAudienceGate
      anonymous={() => <PublicTemplatesCatalogue />}
      checking={<TemplateListSkeleton />}
      member={(organizationId) => (
        <Suspense fallback={<TemplateListSkeleton />}>
          <LazyMemberTemplatesPage organizationId={organizationId} />
        </Suspense>
      )}
    />
  );
}
