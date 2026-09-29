import { getRouteApi, useNavigate } from "@tanstack/react-router";

import { loadCatalogue } from "@stll/catalogue";
import { ScrollArea } from "@stll/ui/scroll-area";

import { CatalogueRow } from "@/components/catalogue/catalogue-row";
import { toKnowledgeTool } from "@/features/knowledge/public/public-tools";
import { ToolsCatalogueView } from "@/features/knowledge/views/tools/tools-catalogue-view";
import { ToolsPageHeader } from "@/features/knowledge/views/tools/tools-page-chrome";
import { detached } from "@/lib/detached";

const toolsRouteApi = getRouteApi("/knowledge/tools");

/** The published tools for a visitor without an account; each opens its own
 *  page. */
export function PublicToolsCatalogue() {
  const navigate = useNavigate();
  const initialKind = toolsRouteApi.useSearch({ select: (s) => s.kind });
  // The published catalogue ships with the app; nothing is read per visitor.
  const tools = loadCatalogue().map(toKnowledgeTool);

  return (
    <ScrollArea axis="vertical" className="flex-1">
      <div className="flex flex-col p-6">
        <ToolsPageHeader />
        <ToolsCatalogueView
          initialKind={initialKind}
          renderEntry={(tool) => (
            <CatalogueRow
              display={tool}
              focused={false}
              key={`${tool.kind}:${tool.slug}`}
              onFocus={() => {
                detached(
                  navigate({
                    to: "/knowledge/tools/$entry",
                    params: { entry: tool.slug },
                  }),
                  "public-tools-catalogue.open",
                );
              }}
            />
          )}
          source={{ entries: tools }}
        />
      </div>
    </ScrollArea>
  );
}
