import { ChevronRightIcon } from "lucide-react";
import { useFormatter, useTranslations } from "use-intl";

import { DirectionalIcon } from "@stll/ui/components/directional-icon";

import {
  FlowStatusBadge,
  FlowTriggerBadge,
} from "@/components/flows/flow-badges";
import type { FlowRunListItem } from "@/routes/_protected.workspaces/$workspaceId/-components/flows/flow-run-types";

type RunsListProps = {
  runs: FlowRunListItem[];
  onSelect: (runId: string) => void;
};

export const RunsList = ({ runs, onSelect }: RunsListProps) => {
  const t = useTranslations();

  if (runs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed p-8">
        <p className="text-sm font-medium">{t("flows.runs.empty")}</p>
        <p className="text-muted-foreground text-sm">
          {t("flows.runs.emptyDescription")}
        </p>
      </div>
    );
  }

  return (
    <ul className="divide-y rounded-lg border">
      {runs.map((run) => (
        <RunRow key={run.id} onSelect={() => onSelect(run.id)} run={run} />
      ))}
    </ul>
  );
};

const RunRow = ({
  run,
  onSelect,
}: {
  run: FlowRunListItem;
  onSelect: () => void;
}) => {
  const t = useTranslations();
  const format = useFormatter();

  const timestamp = run.startedAt ?? run.createdAt;

  return (
    <li>
      <button
        className="hover:bg-muted/50 flex w-full items-center gap-3 px-4 py-3 text-start"
        onClick={onSelect}
        type="button"
      >
        <FlowStatusBadge status={run.status} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium" dir="auto">
            {run.name}
          </p>
          <div className="text-muted-foreground mt-0.5 flex items-center gap-2 text-xs">
            <FlowTriggerBadge triggerType={run.triggerType} />
            <span className="tabular-nums">
              {format.dateTime(new Date(timestamp), {
                dateStyle: "medium",
                timeStyle: "short",
              })}
            </span>
            <span className="tabular-nums">
              {t("flows.runs.stepProgress", {
                current: format.number(
                  Math.min(run.currentStepIndex + 1, run.stepCount),
                ),
                total: format.number(run.stepCount),
              })}
            </span>
          </div>
        </div>
        <DirectionalIcon
          className="text-muted-foreground size-4 shrink-0"
          icon={ChevronRightIcon}
        />
      </button>
    </li>
  );
};
