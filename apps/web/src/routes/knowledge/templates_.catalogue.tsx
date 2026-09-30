import { createFileRoute, notFound } from "@tanstack/react-router";

import { getTranslator } from "@/i18n/i18n-store";
import {
  isPublicKnowledgeCrawlAllowed,
  isPublicKnowledgeEnabled,
} from "@/lib/knowledge/public-knowledge-launch";
import { pageTitle } from "@/lib/page-title";
import { createPublicHead } from "@/lib/public-seo";
import { PublicTemplatesCatalogue } from "@/routes/knowledge/-public/public-templates-catalogue";

// The published catalogue, the same for every visitor; a member reaches it
// from the library's catalogue tab.
export const Route = createFileRoute("/knowledge/templates_/catalogue")({
  beforeLoad: () => {
    if (!isPublicKnowledgeEnabled()) {
      notFound({ throw: true });
    }
  },
  head: () =>
    createPublicHead({
      crawlAllowed: isPublicKnowledgeCrawlAllowed(),
      description: getTranslator()("knowledge.sections.templates.description"),
      path: "/knowledge/templates/catalogue",
      title: pageTitle("knowledge.sections.templates.title"),
      type: "website",
    }),
  component: PublicTemplatesCatalogue,
});
