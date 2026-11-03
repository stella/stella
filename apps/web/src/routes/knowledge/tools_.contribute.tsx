import { createFileRoute, notFound } from "@tanstack/react-router";

import { createToolContributeHead } from "@/features/knowledge/public/tools/tool-contribute-head";
import { ContributePage } from "@/features/knowledge/public/tools/tool-contribute-page";
import { isPublicKnowledgeEnabled } from "@/lib/knowledge/public-knowledge-launch";
import { routePresentation } from "@/routes/-route-presentation";

export const Route = createFileRoute("/knowledge/tools_/contribute")({
  staticData: { presentation: routePresentation({ type: "inherit" }) },
  beforeLoad: () => {
    if (!isPublicKnowledgeEnabled()) {
      notFound({ throw: true });
    }
  },
  head: createToolContributeHead,
  component: ContributePage,
});
