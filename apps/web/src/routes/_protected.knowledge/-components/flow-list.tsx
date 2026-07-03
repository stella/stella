import { PlusIcon, RotateCcwIcon, WorkflowIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";

import { FlowTriggerBadge } from "@/components/flows/flow-badges";
import { FlowSwitch } from "@/components/flows/flow-switch";
import { usePermissions } from "@/hooks/use-permissions";
import type { FlowListItem } from "@/routes/_protected.knowledge/-components/flow-types";

type FlowListProps = {
  flows: FlowListItem[];
  togglingId: string | null;
  onNewFlow: () => void;
  onSelect: (flow: FlowListItem) => void;
  onToggleEnabled: (flow: FlowListItem, enabled: boolean) => void;
  onRefresh: () => void;
};

export const FlowList = ({
  flows,
  togglingId,
  onNewFlow,
  onSelect,
  onToggleEnabled,
  onRefresh,
}: FlowListProps) => {
  const t = useTranslations();
  const canCreate = usePermissions({ flow: ["create"] });
  const canUpdate = usePermissions({ flow: ["update"] });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-end gap-1 border-b px-4 py-2">
        <Button
          aria-label={t("common.refresh")}
          onClick={onRefresh}
          size="icon-sm"
          title={t("common.refresh")}
          variant="ghost"
        >
          <RotateCcwIcon />
        </Button>
        {canCreate && (
          <Button
            aria-label={t("flows.createFlow")}
            onClick={onNewFlow}
            size="sm"
            title={t("flows.createFlow")}
          >
            <PlusIcon />
            <span className="hidden sm:inline">{t("flows.createFlow")}</span>
          </Button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {flows.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-1 p-8">
            <p className="text-sm font-medium">{t("flows.empty")}</p>
            <p className="text-muted-foreground text-sm">
              {t("flows.emptyDescription")}
            </p>
          </div>
        )}

        <ul className="divide-y">
          {flows.map((flow) => (
            <FlowRow
              canToggle={canUpdate}
              flow={flow}
              key={flow.id}
              onSelect={() => onSelect(flow)}
              onToggleEnabled={(enabled) => onToggleEnabled(flow, enabled)}
              toggling={togglingId === flow.id}
            />
          ))}
        </ul>
      </div>
    </div>
  );
};

const FlowRow = ({
  flow,
  canToggle,
  toggling,
  onSelect,
  onToggleEnabled,
}: {
  flow: FlowListItem;
  canToggle: boolean;
  toggling: boolean;
  onSelect: () => void;
  onToggleEnabled: (enabled: boolean) => void;
}) => {
  const t = useTranslations();

  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <button
        className="flex min-w-0 flex-1 items-center gap-3 text-start"
        onClick={onSelect}
        type="button"
      >
        <div className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-lg">
          <WorkflowIcon className="text-muted-foreground size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium" dir="auto">
            {flow.name}
          </p>
          <div className="text-muted-foreground mt-0.5 flex items-center gap-2 text-xs">
            <FlowTriggerBadge triggerType={flow.triggerType} />
            <span>{t("flows.stepCount", { count: flow.stepCount })}</span>
          </div>
        </div>
        <span className="sr-only">{t("common.edit")}</span>
      </button>
      <FlowSwitch
        aria-label={
          flow.enabled ? t("flows.disableFlow") : t("flows.enableFlow")
        }
        checked={flow.enabled}
        disabled={!canToggle || toggling}
        onCheckedChange={onToggleEnabled}
      />
    </li>
  );
};
