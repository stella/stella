import { Link, useNavigate } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { loadCatalogue } from "@stll/catalogue";
import { Button } from "@stll/ui/button";
import { PlusIcon } from "@stll/ui/icons";

import { CatalogueRow } from "@/components/catalogue/catalogue-row";
import { toKnowledgeTool } from "@/features/knowledge/public/public-tools";
import { ToolsCatalogueView } from "@/features/knowledge/views/tools/tools-catalogue-view";
import { detached } from "@/lib/detached";

/** The published tools for every visitor; each opens its own page. */
export function PublicToolsCatalogue() {
  const t = useTranslations();
  const navigate = useNavigate();
  // The published catalogue ships with the app; nothing is read per visitor.
  const tools = loadCatalogue().map(toKnowledgeTool);

  return (
    <ToolsCatalogueView
      addAction={
        <Button
          render={<Link to="/knowledge/tools/contribute" />}
          variant="ghost"
        >
          <PlusIcon />
          {t("publicTools.addSkill")}
        </Button>
      }
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
  );
}
