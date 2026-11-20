import { PublicTemplatesCatalogue } from "@/routes/knowledge/-public/public-templates-catalogue";
import { TemplatesCatalogueShell } from "@/routes/knowledge/-public/templates-catalogue.pending";

/** The published template catalogue, the same for every visitor. */
export const TemplatesCataloguePage = () => (
  <TemplatesCatalogueShell>
    <PublicTemplatesCatalogue />
  </TemplatesCatalogueShell>
);
