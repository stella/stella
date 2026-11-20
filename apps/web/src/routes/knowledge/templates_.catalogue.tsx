import { createFileRoute, notFound, Outlet } from "@tanstack/react-router";

import { isPublicKnowledgeEnabled } from "@/lib/knowledge/public-knowledge-launch";
import { LeafPendingView } from "@/routes/-route-pending-view";

// The catalogue and its detail pages share the public availability gate.
export const Route = createFileRoute("/knowledge/templates_/catalogue")({
  beforeLoad: () => {
    if (!isPublicKnowledgeEnabled()) {
      notFound({ throw: true });
    }
  },
  component: TemplatesCatalogueLayout,
  // A layout: while its gate runs, its pending view is the catalogue page it
  // leads to.
  pendingComponent: LeafPendingView,
});

function TemplatesCatalogueLayout() {
  return <Outlet />;
}
