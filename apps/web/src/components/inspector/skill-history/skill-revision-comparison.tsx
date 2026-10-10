import type { ReactNode } from "react";

import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Skeleton } from "@stll/ui/skeleton";

import { toEditorMarkdown } from "@/components/skill-body-markdown";
import { detached } from "@/lib/detached";
import type { QueryView } from "@/lib/query-view.logic";

type SkillRevisionComparisonProps = {
  view: QueryView<{ body: string }, unknown> | null;
  children: (baseline: string | undefined) => ReactNode;
};

export const SkillRevisionComparison = ({
  view,
  children,
}: SkillRevisionComparisonProps) => {
  const t = useTranslations();
  const readError = (retry: () => Promise<unknown>) => (
    <div className="flex items-center gap-2 py-2" role="alert">
      <p className="text-destructive text-sm">
        {t("common.somethingWentWrong")}
      </p>
      <Button
        onClick={() => detached(retry(), "skill-revision-comparison.retry")}
        size="sm"
        variant="ghost"
      >
        {t("common.retry")}
      </Button>
    </div>
  );
  const renderStatus = () => {
    if (view === null) {
      return null;
    }
    switch (view.type) {
      case "pending":
        return (
          <div aria-label={t("common.loading")} role="status">
            <Skeleton className="h-16 w-full" />
          </div>
        );
      case "error":
        return readError(view.retry);
      case "empty":
        return (
          <p className="text-muted-foreground text-sm">
            {t("common.noResults")}
          </p>
        );
      case "items":
        return view.refetchError !== undefined ? readError(view.retry) : null;
      default:
        view satisfies never;
        return panic("Unhandled SkillRevisionComparison query state");
    }
  };
  // Query notices occupy their own slot; the live editor keeps its model.
  return (
    <>
      {renderStatus()}
      {children(
        view?.type === "items" ? toEditorMarkdown(view.items.body) : undefined,
      )}
    </>
  );
};
