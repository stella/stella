import { createFileRoute, notFound } from "@tanstack/react-router";

import { isPublicKnowledgeEnabled } from "@/lib/public-knowledge-launch";
import { PublicTemplatesCatalogue } from "@/routes/knowledge/-public/public-templates-catalogue";

// The published catalogue, the same for every visitor; a member reaches it
// from the library's catalogue tab.
export const Route = createFileRoute("/knowledge/templates_/catalogue")({
  beforeLoad: () => {
    if (!isPublicKnowledgeEnabled()) {
      throw notFound();
    }
  },
  component: PublicTemplatesCatalogue,
});
