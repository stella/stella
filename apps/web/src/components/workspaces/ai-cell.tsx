import type { ReactNode } from "react";

import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { RefreshCwIcon } from "@stll/ui/icons";
import { Loader } from "@stll/ui/loader";

import type { AiCellState } from "@/components/workspaces/ai-cell-state.logic";

type AiCellProps = {
  state: AiCellState;
  children?: ReactNode;
  failure?: ReactNode;
  preview?: string | null;
  onRetry?: () => void;
};

/** All AI table hosts render lifecycle feedback here; hosts own only values and provenance. */
export const AiCell = ({
  state,
  children,
  failure,
  preview,
  onRetry,
}: AiCellProps) => {
  const t = useTranslations();
  switch (state.type) {
    case "done":
      return (
        <span data-ai-cell-state="done" className="contents">
          {children}
        </span>
      );
    case "not_run":
      return (
        <span
          data-ai-cell-state="not_run"
          className="text-foreground-placeholder text-xs"
        >
          {t("caseLaw.research.answers.notRun")}
        </span>
      );
    case "queued":
    case "running":
      return (
        <span
          data-ai-cell-state={state.type}
          role="status"
          aria-busy="true"
          className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs"
        >
          <Loader
            aria-hidden="true"
            label={t(
              state.type === "queued"
                ? "common.queued"
                : "caseLaw.research.answers.pending",
            )}
            size="sm"
          />
          <span className="line-clamp-2 min-w-0" dir="auto">
            {preview?.trim() ||
              t(
                state.type === "queued"
                  ? "common.queued"
                  : "caseLaw.research.answers.pending",
              )}
          </span>
        </span>
      );
    case "failed":
    case "refused_budget":
      return (
        <span
          data-ai-cell-state={state.type}
          className="flex min-w-0 items-start gap-1"
        >
          <span className="text-destructive min-w-0 text-xs">
            {failure ??
              t(
                state.type === "refused_budget"
                  ? "aiColumns.refusedBudget"
                  : "workspaces.fields.errored",
              )}
          </span>
          {onRetry !== undefined && (
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={t("common.retry")}
              onClick={onRetry}
            >
              <RefreshCwIcon aria-hidden="true" />
            </Button>
          )}
        </span>
      );
    default:
      state satisfies never;
      return panic("Unhandled AI cell state");
  }
};
