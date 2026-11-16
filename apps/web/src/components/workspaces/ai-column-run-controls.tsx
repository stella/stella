import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { PlayIcon } from "@stll/ui/icons";
import { cn } from "@stll/ui/utils";

import type {
  AiColumnRunReveal,
  aiColumnRunScope,
} from "@/components/workspaces/ai-column-run.logic";
import { useFormatter } from "@/i18n/formatting-context";
import { CapabilityAction } from "@/lib/organization/feature-access/capability-actions";

// The Play sits in a table column header (`group/table-head`). Opacity, not
// display, hides it: the button keeps its slot, so the header name never
// reflows on hover, and it stays in the tab order, so focus reveals it. A
// coarse pointer has no hover, so touch keeps it on screen.
const RUN_REVEAL_CLASS = {
  pinned: "",
  "on-interaction":
    "opacity-0 transition-opacity duration-150 ease-out group-focus-within/table-head:opacity-100 group-hover/table-head:opacity-100 pointer-coarse:opacity-100",
} as const satisfies Record<AiColumnRunReveal, string>;

type AiColumnRunButtonProps = {
  scope: ReturnType<typeof aiColumnRunScope>;
  reveal: AiColumnRunReveal;
  disabled: boolean;
  onRun: () => void;
};

export const AiColumnRunButton = ({
  scope,
  reveal,
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
    <span
      className={cn("flex shrink-0", RUN_REVEAL_CLASS[reveal])}
      data-run-reveal={reveal}
    >
      <CapabilityAction action={{ capability: "ai" }} surface="control">
        {(capabilityProps) => (
          <Button
            aria-label={label}
            tooltip={label}
            disabled={disabled}
            onClick={onRun}
            size="icon-xs"
            variant="ghost"
            {...capabilityProps}
          >
            <PlayIcon />
          </Button>
        )}
      </CapabilityAction>
    </span>
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
      <CapabilityAction action={{ capability: "ai" }} surface="control">
        {(capabilityProps) => (
          <Button
            disabled={disabled}
            onClick={onRun}
            size="sm"
            variant="outline"
            {...capabilityProps}
          >
            <PlayIcon />
            {t("aiColumns.selectedRun", { count: rows })}
          </Button>
        )}
      </CapabilityAction>
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
