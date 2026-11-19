import { Link } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

/**
 * A tool address that names nothing: no published tool by that slug, or a
 * skill a visitor without an account cannot open. The route renders it
 * eagerly as its not-found view, so it stays apart from the page.
 */
export function ToolEntryNotFound() {
  const t = useTranslations();

  return (
    <main className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-muted-foreground text-sm">
        {t("publicTools.notFound")}
      </p>
      <Button render={<Link to="/knowledge/tools" />}>
        {t("common.back")}
      </Button>
    </main>
  );
}
