import { LoaderCircleIcon, SparklesIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { useWorkflowStatus } from "@/routes/_protected.workspaces/$workspaceId/-queries/workspace";

import { hasActiveExtractionProgress } from "./extraction-run-progress.logic";

type ExtractionRunProgressProps = {
  workspaceId: string;
};

export const ExtractionRunProgress = ({
  workspaceId,
}: ExtractionRunProgressProps) => {
  const t = useTranslations();
  const { data } = useWorkflowStatus(workspaceId);
  if (!data?.running) {
    return null;
  }

  const run = data.run;
  const hasProgress = hasActiveExtractionProgress(run);

  return (
    <div
      aria-label={
        hasProgress
          ? `${t("common.loading")} ${run.completed} / ${run.total}`
          : t("common.loading")
      }
      className="bg-muted text-muted-foreground flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs tabular-nums"
      role="status"
    >
      {run?.status === "finalizing" ? (
        <SparklesIcon aria-hidden="true" className="size-3.5" />
      ) : (
        <LoaderCircleIcon
          aria-hidden="true"
          className="size-3.5 animate-spin"
        />
      )}
      {hasProgress ? `${run.completed} / ${run.total}` : t("common.loading")}
    </div>
  );
};
