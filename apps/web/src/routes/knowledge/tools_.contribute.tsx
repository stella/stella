import { createFileRoute, notFound } from "@tanstack/react-router";

import { isPublicKnowledgeEnabled } from "@/lib/public-knowledge-launch";
import {
  ContributePage,
  createToolContributeHead,
} from "@/routes/knowledge/-public/tool-contribute-page";

export const Route = createFileRoute("/knowledge/tools_/contribute")({
  beforeLoad: () => {
    if (!isPublicKnowledgeEnabled()) {
      throw notFound();
    }
  },
  head: createToolContributeHead,
  component: ContributePage,
});
