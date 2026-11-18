import { createFileRoute, notFound } from "@tanstack/react-router";

import { getTranslator } from "@/i18n/i18n-store";
import { KNOWLEDGE_CATALOGUE_PATHS } from "@/lib/knowledge/knowledge-catalogues";
import {
  isPublicKnowledgeCrawlAllowed,
  isPublicKnowledgeEnabled,
} from "@/lib/knowledge/public-knowledge-launch";
import { pageTitle } from "@/lib/page-title";
import { createPublicHead } from "@/lib/public-seo";
import { routePresentation } from "@/routes/-route-presentation";
import { PlaybooksCataloguePage } from "@/routes/knowledge/-public/playbooks-catalogue.page";
import { PlaybooksCataloguePending } from "@/routes/knowledge/-public/playbooks-catalogue.pending";

/** The ready-made playbooks: the same for every visitor, members included. */
export const Route = createFileRoute("/knowledge/playbooks_/catalogue")({
  staticData: {
    presentation: routePresentation({
      type: "label",
      labelKey: "common.playbooks",
      to: KNOWLEDGE_CATALOGUE_PATHS.playbooks,
    }),
  },
  beforeLoad: () => {
    if (!isPublicKnowledgeEnabled()) {
      notFound({ throw: true });
    }
  },
  head: () =>
    createPublicHead({
      crawlAllowed: isPublicKnowledgeCrawlAllowed(),
      description: getTranslator()("knowledge.sections.playbooks.description"),
      path: KNOWLEDGE_CATALOGUE_PATHS.playbooks,
      title: pageTitle("common.playbooks"),
      type: "website",
    }),
  component: PlaybooksCataloguePage,
  pendingComponent: PlaybooksCataloguePending,
});
