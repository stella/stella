import { createFileRoute, notFound, Outlet } from "@tanstack/react-router";

import { isPublicKnowledgeEnabled } from "@/lib/knowledge/public-knowledge-launch";

// The catalogue and its detail pages share the public availability gate.
export const Route = createFileRoute("/knowledge/templates_/catalogue")({
  beforeLoad: () => {
    if (!isPublicKnowledgeEnabled()) {
      notFound({ throw: true });
    }
  },
  component: Outlet,
});
