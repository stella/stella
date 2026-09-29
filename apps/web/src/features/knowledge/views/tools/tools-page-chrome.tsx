import { useTranslations } from "use-intl";

import { Skeleton } from "@stll/ui/skeleton";

// The page's own chrome, kept apart from the catalogue view so a route can
// render it while the catalogue loads behind React.lazy.

export const ToolsPageHeader = () => {
  const t = useTranslations();
  return (
    <div className="mb-6 flex flex-col gap-1">
      <h1 className="text-foreground text-xl font-semibold">
        {t("knowledge.sections.tools.title")}
      </h1>
      <p className="text-muted-foreground text-sm">
        {t("knowledge.sections.tools.description")}
      </p>
    </div>
  );
};

const CATALOGUE_FILTER_KEYS = ["all", "skill", "mcp"];
const CATALOGUE_ROW_KEYS = ["a", "b", "c", "d", "e", "f"];

// Mirrors the catalogue view body (toolbar row, filter pills, then a stack of
// bordered entry cards) so the Tools page chrome stays put and only the
// catalogue values stream in.
export const ToolsCatalogueSkeleton = () => (
  <div className="flex flex-col gap-6">
    <div className="flex items-center gap-2">
      <Skeleton className="h-9 flex-1 rounded-md" />
      <Skeleton className="h-9 w-24 rounded-md" />
      <Skeleton className="h-9 w-28 rounded-md" />
    </div>

    <div className="flex items-center gap-1.5">
      {CATALOGUE_FILTER_KEYS.map((key) => (
        <Skeleton className="h-6 w-14 rounded-md" key={key} />
      ))}
    </div>

    <div className="flex flex-col gap-2">
      <Skeleton className="mb-1 h-3 w-28" />
      {CATALOGUE_ROW_KEYS.map((key) => (
        <div className="flex items-start gap-3 rounded-lg border p-3" key={key}>
          <Skeleton className="mt-0.5 size-6 shrink-0 rounded-md" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex min-h-6 items-center gap-2">
              <Skeleton className="h-4 w-40" />
            </div>
            <Skeleton className="h-3 w-3/4" />
            <div className="flex flex-wrap items-center gap-1.5">
              <Skeleton className="h-5 w-12 rounded-md" />
              <Skeleton className="h-5 w-16 rounded-md" />
            </div>
          </div>
        </div>
      ))}
    </div>
  </div>
);
