import { PlusIcon, RotateCcwIcon, WorkflowIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";

import { FlowTriggerBadge } from "@/components/flows/flow-badges";
import { FlowSwitch } from "@/components/flows/flow-switch";
import { usePermissions } from "@/hooks/use-permissions";
import {
  buildFlowExample,
  FLOW_EXAMPLE_KEYS,
  type FlowExampleKey,
} from "@/routes/_protected.knowledge/-components/flow-examples";
import type { FlowListItem } from "@/routes/_protected.knowledge/-components/flow-types";

type FlowListProps = {
  flows: FlowListItem[];
  togglingId: string | null;
  onNewFlow: () => void;
  onSelect: (flow: FlowListItem) => void;
  onStartExample: (example: FlowExampleKey) => void;
  onToggleEnabled: (flow: FlowListItem, enabled: boolean) => void;
  onRefresh: () => void;
};

export const FlowList = ({
  flows,
  togglingId,
  onNewFlow,
  onSelect,
  onStartExample,
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
          <FlowEmptyState
            canCreate={canCreate}
            onNewFlow={onNewFlow}
            onStartExample={onStartExample}
          />
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

const FlowEmptyState = ({
  canCreate,
  onNewFlow,
  onStartExample,
}: {
  canCreate: boolean;
  onNewFlow: () => void;
  onStartExample: (example: FlowExampleKey) => void;
}) => {
  const t = useTranslations();

  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <div className="text-center">
        <h2 className="text-foreground text-base font-medium text-balance">
          {t("flows.emptyState.title")}
        </h2>
        <p className="text-muted-foreground mt-2 text-sm text-balance">
          {t("flows.emptyState.description")}
        </p>
      </div>

      {canCreate && (
        <>
          <div className="mt-8">
            <h3 className="text-muted-foreground text-sm font-medium">
              {t("flows.emptyState.examplesTitle")}
            </h3>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              {FLOW_EXAMPLE_KEYS.map((key) => (
                <FlowExampleCard
                  key={key}
                  exampleKey={key}
                  onSelect={() => onStartExample(key)}
                />
              ))}
            </div>
          </div>

          <div className="mt-6 flex justify-center">
            <Button onClick={onNewFlow} type="button" variant="outline">
              {t("flows.emptyState.blankAction")}
            </Button>
          </div>
        </>
      )}
    </div>
  );
};

const FlowExampleCard = ({
  exampleKey,
  onSelect,
}: {
  exampleKey: FlowExampleKey;
  onSelect: () => void;
}) => {
  const t = useTranslations();
  const example = buildFlowExample(exampleKey, t);

  return (
    <button
      className="border-border hover:border-foreground/30 hover:bg-muted/40 flex flex-col items-start gap-1 rounded-lg border p-4 text-start transition-colors"
      onClick={onSelect}
      type="button"
    >
      <span className="text-foreground text-sm font-medium">
        {example.name}
      </span>
      <span className="text-muted-foreground text-sm">
        {example.description}
      </span>
    </button>
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
