import { lazy, Suspense } from "react";

import { createFileRoute } from "@tanstack/react-router";

import { PlaybooksPageSkeleton } from "@/features/knowledge/views/playbooks/playbooks-page-view";
import { playbooksIntentSearchSchema } from "@/lib/knowledge/catalogue-intent";
import { KnowledgeAudienceGate } from "@/routes/knowledge/-knowledge-audience-gate";
import { PublicPlaybooksCatalogue } from "@/routes/knowledge/-public/public-playbooks-catalogue";

// The organization's playbooks load only for a member, after the session is
// known; the page reads them itself, so nothing is fetched before that.
const LazyMemberPlaybooksPage = lazy(async () => {
  const module =
    await import("@/routes/knowledge/-member/member-playbooks-page");
  return { default: module.MemberPlaybooksPage };
});

export const Route = createFileRoute("/knowledge/playbooks")({
  validateSearch: playbooksIntentSearchSchema,
  component: PlaybooksSection,
});

function PlaybooksSection() {
  return (
    <KnowledgeAudienceGate
      anonymous={() => <PublicPlaybooksCatalogue />}
      checking={<PlaybooksPageSkeleton />}
      member={(organizationId) => (
        <Suspense fallback={<PlaybooksPageSkeleton />}>
          <LazyMemberPlaybooksPage organizationId={organizationId} />
        </Suspense>
      )}
    />
  );
}
