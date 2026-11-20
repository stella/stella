import { Link } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import { KNOWLEDGE_CATALOGUE_PATHS } from "@/lib/knowledge/knowledge-catalogues";

/**
 * A tool address that names nothing: no published tool by that slug, or a
 * skill a visitor without an account cannot open. The route renders it
 * eagerly as its not-found view, so it stays apart from the page. Back
 * leads to the published list, which every visitor can read.
 */
export function ToolEntryNotFound() {
  const t = useTranslations();

  return (
    <main className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-muted-foreground text-sm">
        {t("publicTools.notFound")}
      </p>
      <Button render={<Link to={KNOWLEDGE_CATALOGUE_PATHS.tools} />}>
        {t("common.back")}
      </Button>
    </main>
  );
}
