import { createFileRoute, notFound } from "@tanstack/react-router";

import { createToolContributeHead } from "@/features/knowledge/public/tools/tool-contribute-head";
import { isPublicKnowledgeEnabled } from "@/lib/knowledge/public-knowledge-launch";
import { routePresentation } from "@/routes/-route-presentation";
import { ToolContributePage } from "@/routes/knowledge/-public/tool-contribute.page";
import { ToolContributePending } from "@/routes/knowledge/-public/tool-contribute.pending";

export const Route = createFileRoute("/knowledge/tools_/contribute")({
  staticData: { presentation: routePresentation({ type: "inherit" }) },
  beforeLoad: () => {
    if (!isPublicKnowledgeEnabled()) {
      notFound({ throw: true });
    }
  },
  head: createToolContributeHead,
  component: ToolContributePage,
  pendingComponent: ToolContributePending,
});
