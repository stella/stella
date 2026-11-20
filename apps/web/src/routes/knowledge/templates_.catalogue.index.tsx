import { createFileRoute } from "@tanstack/react-router";

import { getTranslator } from "@/i18n/i18n-store";
import { isPublicKnowledgeCrawlAllowed } from "@/lib/knowledge/public-knowledge-launch";
import { pageTitle } from "@/lib/page-title";
import { createPublicHead } from "@/lib/public-seo";
import { TemplatesCataloguePage } from "@/routes/knowledge/-public/templates-catalogue.page";
import { TemplatesCataloguePending } from "@/routes/knowledge/-public/templates-catalogue.pending";

export const Route = createFileRoute("/knowledge/templates_/catalogue/")({
  head: () =>
    createPublicHead({
      crawlAllowed: isPublicKnowledgeCrawlAllowed(),
      description: getTranslator()("knowledge.sections.templates.description"),
      path: "/knowledge/templates/catalogue",
      title: pageTitle("knowledge.sections.templates.title"),
      type: "website",
    }),
  component: TemplatesCataloguePage,
  pendingComponent: TemplatesCataloguePending,
});
