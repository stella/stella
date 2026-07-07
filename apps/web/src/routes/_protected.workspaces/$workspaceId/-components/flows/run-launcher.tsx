import { useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PlayIcon } from "lucide-react";
import { useFormatter, useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { Checkbox } from "@stll/ui/components/checkbox";
import { Input } from "@stll/ui/components/input";
import { Label } from "@stll/ui/components/label";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/components/select";
import { stellaToast } from "@stll/ui/components/toast";

import { usePermissions } from "@/hooks/use-permissions";
import { api } from "@/lib/api";
import { userErrorMessage } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";
import {
  FLOW_PICKER_LIMIT,
  flowsOptions,
} from "@/routes/_protected.knowledge/-queries";
import { entitySummariesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import { flowRunsKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/flow-runs";

type RunLauncherProps = {
  workspaceId: string;
  organizationId: string;
  onStarted: (runId: string) => void;
};

// Mirrors `flowRunInputEntitiesMax` in apps/api/src/lib/limits.ts. apps/api
// types are not importable from apps/web, so this is kept as a local
// constant; the backend rejects a run start past this count regardless of
// what the client enforces.
const FLOW_RUN_INPUT_ENTITIES_MAX = 50;

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
    entity.name.toLowerCase().includes(entityFilter.toLowerCase()),
  );

  const exceedsInputEntitiesLimit =
    selectedEntityIds.length > FLOW_RUN_INPUT_ENTITIES_MAX;

  const toggleEntity = (id: string, checked: boolean) => {
    setSelectedEntityIds((prev) =>
      checked ? [...prev, id] : prev.filter((existing) => existing !== id),
    );
  };

  const handleStart = async () => {
    if (!definitionId || exceedsInputEntitiesLimit) {
      return;
    }
    setStarting(true);
    const response = await api
      .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
      .flows.runs.post({
        definitionId: toSafeId<"flowDefinition">(definitionId),
        inputEntityIds: selectedEntityIds.map((id) => toSafeId<"entity">(id)),
        queryKey: flowRunsKeys.all(workspaceId),
      });
    setStarting(false);

    if (response.error) {
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
    void queryClient.invalidateQueries({
      queryKey: flowRunsKeys.all(workspaceId),
    });
    onStarted(response.data.runId);
  };

  if (enabledFlows.length === 0) {
    return (
      <div className="rounded-lg border p-4">
        <p className="text-muted-foreground text-sm">
          {t("flows.runs.noEnabledFlows")}
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

      <div className="flex justify-end">
        <Button
          disabled={
            !canRun || !definitionId || starting || exceedsInputEntitiesLimit
          }
          loading={starting}
          onClick={() => {
            void handleStart();
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
