import { createFileRoute, notFound } from "@tanstack/react-router";

import { getTranslator } from "@/i18n/i18n-store";
import { KNOWLEDGE_CATALOGUE_PATHS } from "@/lib/knowledge/knowledge-catalogues";
import { isPublicKnowledgeEnabled } from "@/lib/knowledge/public-knowledge-launch";
import { pageTitle } from "@/lib/page-title";
import { createPublicToolsHead } from "@/lib/public-tools-seo";
import { routePresentation } from "@/routes/-route-presentation";
import { ToolsCataloguePage } from "@/routes/knowledge/-public/tools-catalogue.page";
import { ToolsCataloguePending } from "@/routes/knowledge/-tools/tools-catalogue.pending";

/** The published tools' list: the same for every visitor, members included. */
export const Route = createFileRoute("/knowledge/tools_/catalogue")({
  staticData: {
    presentation: routePresentation({
      type: "label",
      labelKey: "knowledge.sections.tools.title",
      to: KNOWLEDGE_CATALOGUE_PATHS.tools,
    }),
  },
  beforeLoad: () => {
    if (!isPublicKnowledgeEnabled()) {
      notFound({ throw: true });
    }
  },
  head: () =>
    createPublicToolsHead({
      description: getTranslator()("publicTools.metaDescription"),
      path: KNOWLEDGE_CATALOGUE_PATHS.tools,
      title: pageTitle("knowledge.sections.tools.title"),
      type: "website",
    }),
  component: ToolsCataloguePage,
  pendingComponent: ToolsCataloguePending,
});
