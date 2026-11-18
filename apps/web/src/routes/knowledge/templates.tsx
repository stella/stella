import { createFileRoute } from "@tanstack/react-router";

import { KNOWLEDGE_CATALOGUE_PATHS } from "@/lib/knowledge/knowledge-catalogues";
import { routePresentation } from "@/routes/-route-presentation";
import { turnAwaySignedOutVisitor } from "@/routes/knowledge/-knowledge-member-route";
import { TemplatesPage } from "@/routes/knowledge/-member/templates.page";
import { templatesSearchSchema } from "@/routes/knowledge/-templates-search";
import { TemplatesPending } from "@/routes/knowledge/-templates/templates.pending";

// The organization's template library. The published catalogue has its own
// address, so this page is only ever a member's and its code is preloaded
// with it.
export const Route = createFileRoute("/knowledge/templates")({
  staticData: {
    presentation: routePresentation({
      type: "knowledge-detail",
      detail: "templates",
    }),
  },
  validateSearch: templatesSearchSchema,
  beforeLoad: async ({ context: { queryClient } }) => {
    await turnAwaySignedOutVisitor({
      queryClient,
      visitor: { kind: "catalogue", to: KNOWLEDGE_CATALOGUE_PATHS.templates },
    });
  },
  component: TemplatesPage,
  pendingComponent: TemplatesPending,
});
