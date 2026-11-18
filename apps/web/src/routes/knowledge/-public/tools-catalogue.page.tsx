import { ScrollArea } from "@stll/ui/scroll-area";

import { PublicToolsCatalogue } from "@/routes/knowledge/-public/public-tools-catalogue";
import { ToolsCatalogueShell } from "@/routes/knowledge/-tools/tools-catalogue.pending";

/** The published tools' list, the same for every visitor. */
export const ToolsCataloguePage = () => (
  <ScrollArea axis="vertical" className="flex-1">
    <ToolsCatalogueShell>
      <PublicToolsCatalogue />
    </ToolsCatalogueShell>
  </ScrollArea>
);
