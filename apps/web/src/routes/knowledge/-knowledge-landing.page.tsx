import { getRouteApi } from "@tanstack/react-router";

import { KnowledgeAudienceGate } from "@/routes/knowledge/-knowledge-audience-gate";
import { KnowledgeLandingPending } from "@/routes/knowledge/-knowledge-landing.pending";
import { MemberKnowledgeLanding } from "@/routes/knowledge/-member/member-knowledge-landing";
import { PublicKnowledgeLanding } from "@/routes/knowledge/-public/public-knowledge-landing";

const routeApi = getRouteApi("/knowledge/");

/** The Knowledge landing: the organization's sections for a member, the
 *  open catalogues for a visitor without an account. */
export const KnowledgeLandingPage = () => {
  const from = routeApi.useSearch({ select: (search) => search.from });
  return (
    <KnowledgeAudienceGate
      anonymous={() => <PublicKnowledgeLanding from={from} />}
      checking={<KnowledgeLandingPending />}
      member={() => <MemberKnowledgeLanding />}
    />
  );
};
