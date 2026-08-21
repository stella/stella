import { useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PlayIcon } from "lucide-react";
import { useFormatter, useTranslations } from "use-intl";

import { FLOW_RUN_INPUT_ENTITIES_MAX } from "@stll/api-contract";
import { Button } from "@stll/ui/button";
import { Checkbox } from "@stll/ui/checkbox";
import { Input } from "@stll/ui/input";
import { Label } from "@stll/ui/label";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";
import { stellaToast } from "@stll/ui/toast";

import { RunSizeConfirmDialog } from "@/components/usage/run-size-confirm-dialog";
import { runSizeConfirmationDetail } from "@/components/usage/run-size-confirmation";
import type { RunSizeConfirmationDetail } from "@/components/usage/run-size-confirmation";
import { usePermissions } from "@/hooks/use-permissions";
import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import { userErrorMessage } from "@/lib/errors/user-safe";
import { FLOW_PICKER_LIMIT, flowsOptions } from "@/lib/knowledge/queries";
import { toSafeId } from "@/lib/safe-id";
import { entitySummariesOptions } from "@/lib/workspaces/queries/entities";
import { flowRunsKeys } from "@/lib/workspaces/queries/flow-runs";

type RunLauncherProps = {
  workspaceId: string;
  organizationId: string;
  onStarted: (runId: string) => void;
};

export const RunLauncher = ({
  workspaceId,
  organizationId,
  onStarted,
}: RunLauncherProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const queryClient = useQueryClient();
  const canRun = usePermissions({ flow: ["run"] });

  const [definitionId, setDefinitionId] = useState<string | null>(null);
  // A refused start whose estimated size needs an explicit go-ahead; the
  // dialog re-issues the same request with the estimate restated.
  const [sizeConfirmation, setSizeConfirmation] =
    useState<RunSizeConfirmationDetail | null>(null);
  const [selectedEntityIds, setSelectedEntityIds] = useState<string[]>([]);
  const [entityFilter, setEntityFilter] = useState("");
  const [starting, setStarting] = useState(false);

  const { data: flowsData } = useQuery(
    flowsOptions(organizationId, FLOW_PICKER_LIMIT),
  );
  const { data: entities } = useQuery(entitySummariesOptions(workspaceId));

  const enabledFlows =
    flowsData && "items" in flowsData
      ? flowsData.items.filter((flow) => flow.enabled)
      : [];

  const filteredEntities = (entities ?? []).filter((entity) =>
    (entity.name ?? "").toLowerCase().includes(entityFilter.toLowerCase()),
  );

  const exceedsInputEntitiesLimit =
    selectedEntityIds.length > FLOW_RUN_INPUT_ENTITIES_MAX;

  const toggleEntity = (id: string, checked: boolean) => {
    setSelectedEntityIds((prev) =>
      checked ? [...prev, id] : prev.filter((existing) => existing !== id),
    );
  };

  const handleStart = async (confirmedUnits?: number) => {
    if (!definitionId || exceedsInputEntitiesLimit) {
      return;
    }
    setSizeConfirmation(null);
    setStarting(true);
    const response = await api
      .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
      .flows.runs.post({
        definitionId: toSafeId<"flowDefinition">(definitionId),
        inputEntityIds: selectedEntityIds.map((id) => toSafeId<"entity">(id)),
        ...(confirmedUnits === undefined ? {} : { confirmedUnits }),
      });
    setStarting(false);

    if (response.error) {
      const detail = runSizeConfirmationDetail(response.error);
      if (detail) {
        setSizeConfirmation(detail);
        return;
      }
      stellaToast.add({
        type: "error",
        title: t("flows.runs.startFailed"),
        description: userErrorMessage(
          response.error,
          t("common.unexpectedError"),
        ),
      });
      return;
    }

    stellaToast.add({ type: "success", title: t("flows.runs.started") });
    setDefinitionId(null);
    setSelectedEntityIds([]);
    detached(
      queryClient.invalidateQueries({
        queryKey: flowRunsKeys.all(workspaceId),
      }),
      "run-launcher.invalidate",
    );
    onStarted(response.data.runId);
  };

  if (enabledFlows.length === 0) {
    return (
      <div className="rounded-lg border p-4">
        <p className="text-muted-foreground text-sm">
          {t("flows.runs.noEnabledFlows", {
            sectionName: t("navigation.knowledge"),
          })}
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-4 rounded-lg border p-4">
      <div className="grid gap-1.5">
        <Label htmlFor="flow-run-definition">
          {t("flows.runs.selectFlow")}
        </Label>
        <Select
          onValueChange={(value) => setDefinitionId(value)}
          value={definitionId}
        >
          <SelectTrigger id="flow-run-definition">
            <SelectValue placeholder={t("flows.runs.selectFlow")} />
          </SelectTrigger>
          <SelectPopup>
            {enabledFlows.map((flow) => (
              <SelectItem key={flow.id} value={flow.id}>
                {flow.name}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>

      <div className="grid gap-1.5">
        <Label>{t("flows.runs.inputDocuments")}</Label>
        <Input
          onChange={(e) => setEntityFilter(e.target.value)}
          placeholder={t("common.search")}
          value={entityFilter}
        />
        <div className="grid max-h-56 gap-1 overflow-y-auto rounded-md border p-2">
          {filteredEntities.length === 0 ? (
            <p className="text-muted-foreground p-2 text-xs">
              {t("common.empty")}
            </p>
          ) : (
            filteredEntities.map((entity) => (
              <label
                className="flex items-center gap-2 text-sm"
                key={entity.id}
              >
                <Checkbox
                  checked={selectedEntityIds.includes(entity.id)}
                  onCheckedChange={(checked) =>
                    toggleEntity(entity.id, checked)
                  }
                />
                <span className="truncate" dir="auto">
                  {entity.name}
                </span>
              </label>
            ))
          )}
        </div>
        {exceedsInputEntitiesLimit && (
          <p className="text-xs text-[var(--option-red-fg)]">
            {t("flows.runs.tooManyInputDocuments", {
              max: format.number(FLOW_RUN_INPUT_ENTITIES_MAX),
            })}
          </p>
        )}
      </div>

      <RunSizeConfirmDialog
        confirmLabel={t("flows.runs.start")}
        detail={sizeConfirmation}
        title={t("flows.runs.sizeConfirmTitle")}
        onConfirm={() => {
          detached(
            handleStart(sizeConfirmation?.estimatedUnits),
            "run-launcher.confirm-size",
          );
        }}
        onDismiss={() => setSizeConfirmation(null)}
      />

      <div className="flex justify-end">
        <Button
          disabled={
            !canRun || !definitionId || starting || exceedsInputEntitiesLimit
          }
          loading={starting}
          onClick={() => {
            detached(handleStart(), "run-launcher.start");
          }}
          type="button"
        >
          <PlayIcon />
          {t("flows.runs.start")}
        </Button>
      </div>
    </div>
  );
};
