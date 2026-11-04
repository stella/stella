import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { RefreshCwIcon } from "@stll/ui/icons";
import { stellaToast } from "@stll/ui/toast";

import { useStartWorkflow } from "@/components/workspaces/hooks/use-start-workflow";
import { detached } from "@/lib/detached";
import { useCallerFeatureEnabled } from "@/lib/organization/feature-access/access";
import { CapabilityAction } from "@/lib/organization/feature-access/capability-actions";
import { CALLER_FEATURE } from "@/lib/organization/feature-access/surfaces";
import { queryView } from "@/lib/query-view.logic";
import { staleCellsOptions } from "@/lib/workspaces/queries/stale-cells";

/**
 * "3 columns stale · Re-run": shown once a new document version leaves AI
 * values computed from the old file. One click re-runs exactly those cells
 * (and the columns reading them); nothing re-runs without it.
 */
export const StaleCellsAction = ({ workspaceId }: { workspaceId: string }) => {
  const t = useTranslations();
  const enabled = useCallerFeatureEnabled(CALLER_FEATURE.tableAnalysis);
  const staleView = queryView(
    useQuery({ ...staleCellsOptions(workspaceId), enabled }),
  );
  const startWorkflow = useStartWorkflow(workspaceId);
  const [isStarting, setIsStarting] = useState(false);

  if (!enabled || staleView.type !== "items") {
    return null;
  }
  const columns = staleView.items.propertyIds.length;
  if (columns === 0) {
    return null;
  }

  const rerun = async () => {
    setIsStarting(true);
    try {
      const result = await startWorkflow({ cells: "stale" });
      if (!result) {
        return;
      }
      switch (result.status) {
        case "started":
          stellaToast.add({
            title: t("workspaces.workflow.startedSuccessfully"),
            type: "success",
          });
          return;
        case "already-running":
          stellaToast.add({ title: t("common.running"), type: "info" });
          return;
        case "skipped":
          stellaToast.add({
            title: t("workspaces.workflow.noFieldsToProcess"),
            type: "info",
          });
          return;
        case "ai-unavailable":
        case "failed":
          return;
        default:
          result satisfies never;
          panic("Unhandled workflow start status");
      }
    } finally {
      setIsStarting(false);
    }
  };

  return (
    <CapabilityAction action={{ capability: "ai" }} surface="control">
      {(capabilityProps) => (
        <Button
          disabled={isStarting}
          onClick={() => detached(rerun(), "stale-cells-action.rerun")}
          size="xs"
          variant="outline"
          {...capabilityProps}
        >
          <RefreshCwIcon className="size-3.5" />
          {t("workspaces.workflow.staleColumnsRerun", { count: columns })}
        </Button>
      )}
    </CapabilityAction>
  );
};
