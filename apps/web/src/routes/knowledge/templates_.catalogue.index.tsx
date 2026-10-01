import { createFileRoute } from "@tanstack/react-router";

import { PublicTemplatesCatalogue } from "@/routes/knowledge/-public/public-templates-catalogue";

export const Route = createFileRoute("/knowledge/templates_/catalogue/")({
  component: PublicTemplatesCatalogue,
});
