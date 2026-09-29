import { createFileRoute, notFound } from "@tanstack/react-router";

import {
  ContributePage,
  createToolContributeHead,
} from "@/features/knowledge/public/tools/tool-contribute-page";
import { isPublicKnowledgeEnabled } from "@/lib/knowledge/public-knowledge-launch";

export const Route = createFileRoute("/knowledge/tools_/contribute")({
  beforeLoad: () => {
    if (!isPublicKnowledgeEnabled()) {
      notFound({ throw: true });
    }
  },
  head: createToolContributeHead,
  component: ContributePage,
});
