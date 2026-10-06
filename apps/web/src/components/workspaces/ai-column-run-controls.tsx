import { useFormatter, useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { PlayIcon } from "@stll/ui/icons";

import type { aiColumnRunScope } from "@/components/workspaces/ai-column-run.logic";

type AiColumnRunButtonProps = {
  scope: ReturnType<typeof aiColumnRunScope>;
  hasNotRun: boolean;
  disabled: boolean;
  onRun: () => void;
};

export const AiColumnRunButton = ({
  scope,
  hasNotRun,
  disabled,
  onRun,
}: AiColumnRunButtonProps) => {
  const t = useTranslations();
  const label = t(
    scope.type === "selection"
      ? "aiColumns.runSelectedRows"
      : "aiColumns.runPageRows",
    { count: scope.count },
  );
  return (
    <Button
      aria-label={label}
      tooltip={label}
      disabled={disabled}
      onClick={onRun}
      size="icon-xs"
      variant={hasNotRun ? "default" : "ghost"}
    >
      <PlayIcon />
    </Button>
  );
};

type AiColumnSelectionActionProps = {
  columns: number;
  rows: number;
  disabled: boolean;
  onRun: () => void;
};

export const AiColumnSelectionAction = ({
  columns,
  rows,
  disabled,
  onRun,
}: AiColumnSelectionActionProps) => {
  const t = useTranslations();
  const format = useFormatter();
  return (
    <>
      <Button disabled={disabled} onClick={onRun} size="sm" variant="outline">
        <PlayIcon />
        {t("aiColumns.selectedRun", { count: rows })}
      </Button>
      <span className="text-muted-foreground text-xs tabular-nums">
        {t("aiColumns.countSummary", {
          columns: format.number(columns),
          rows: format.number(rows),
          answers: columns * rows,
        })}
      </span>
    </>
  );
};
