import { lazy, Suspense } from "react";

import { getRouteApi } from "@tanstack/react-router";

import { KnowledgeAudienceGate } from "@/routes/knowledge/-knowledge-audience-gate";
import { KnowledgeLandingPending } from "@/routes/knowledge/-knowledge-landing.pending";
import { PublicKnowledgeLanding } from "@/routes/knowledge/-public/public-knowledge-landing";

// A member's landing reads their role; a visitor without an account never
// loads it, so it loads only once a member is known.
const LazyMemberKnowledgeLanding = lazy(async () => {
  const module =
    await import("@/routes/knowledge/-member/member-knowledge-landing");
  return { default: module.MemberKnowledgeLanding };
});

const routeApi = getRouteApi("/knowledge/");

/** The Knowledge landing: the organization's sections for a member, the
 *  open catalogues for a visitor without an account. */
export const KnowledgeLandingPage = () => {
  const from = routeApi.useSearch({ select: (search) => search.from });
  return (
    <KnowledgeAudienceGate
      anonymous={() => <PublicKnowledgeLanding from={from} />}
      checking={<KnowledgeLandingPending />}
      member={() => (
        <Suspense fallback={<KnowledgeLandingPending />}>
          <LazyMemberKnowledgeLanding />
        </Suspense>
      )}
    />
  );
};
