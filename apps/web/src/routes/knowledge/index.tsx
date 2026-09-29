import { lazy, Suspense } from "react";

import { createFileRoute } from "@tanstack/react-router";
import * as v from "valibot";

import { KnowledgeLandingSkeleton } from "@/features/knowledge/views/knowledge-landing-view";
import { KnowledgeAudienceGate } from "@/routes/knowledge/-knowledge-audience-gate";
import { PublicKnowledgeLanding } from "@/routes/knowledge/-public/public-knowledge-landing";

// A member's landing reads their role; it loads only once a member is known.
const LazyMemberKnowledgeLanding = lazy(async () => {
  const module =
    await import("@/routes/knowledge/-member/member-knowledge-landing");
  return { default: module.MemberKnowledgeLanding };
});

const searchSchema = v.object({
  /** An organization-only Knowledge page a visitor asked for. */
  from: v.fallback(v.optional(v.string()), undefined),
});

export const Route = createFileRoute("/knowledge/")({
  validateSearch: searchSchema,
  component: KnowledgeLanding,
});

function KnowledgeLanding() {
  const from = Route.useSearch({ select: (search) => search.from });
  return (
    <KnowledgeAudienceGate
      anonymous={() => <PublicKnowledgeLanding from={from} />}
      checking={<KnowledgeLandingSkeleton />}
      member={() => (
        <Suspense fallback={<KnowledgeLandingSkeleton />}>
          <LazyMemberKnowledgeLanding />
        </Suspense>
      )}
    />
  );
}
