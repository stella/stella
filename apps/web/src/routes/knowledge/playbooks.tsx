import { createFileRoute } from "@tanstack/react-router";

import { playbooksIntentSearchSchema } from "@/lib/knowledge/catalogue-intent";
import { KNOWLEDGE_CATALOGUE_PATHS } from "@/lib/knowledge/knowledge-catalogues";
import { pageTitle } from "@/lib/page-title";
import { routePresentation } from "@/routes/-route-presentation";
import { turnAwaySignedOutVisitor } from "@/routes/knowledge/-knowledge-member-route";
import { PlaybooksPage } from "@/routes/knowledge/-member/playbooks.page";
import { PlaybooksPending } from "@/routes/knowledge/-playbooks/playbooks.pending";

// The organization's playbooks; the ready-made ones every visitor reads live
// at `/knowledge/playbooks/catalogue`.
export const Route = createFileRoute("/knowledge/playbooks")({
  validateSearch: playbooksIntentSearchSchema,
  staticData: {
    presentation: routePresentation({
      type: "knowledge-detail",
      detail: "playbooks",
    }),
  },
  beforeLoad: async ({ context: { queryClient } }) => {
    await turnAwaySignedOutVisitor({
      queryClient,
      visitor: { kind: "catalogue", to: KNOWLEDGE_CATALOGUE_PATHS.playbooks },
    });
  },
  head: () => ({ meta: [{ title: pageTitle("common.playbooks") }] }),
  component: PlaybooksPage,
  pendingComponent: PlaybooksPending,
});
