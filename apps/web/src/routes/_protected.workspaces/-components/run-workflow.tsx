import { usePostHog } from "@posthog/react";
import { useMutation, useSuspenseQuery } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { Result } from "better-result";
import { CircleFadingArrowUpIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stella/ui/components/button";
import { toastManager } from "@stella/ui/components/toast";

import { captureError } from "@/lib/posthog/utils";
import type { WorkspaceField, WorkspaceProperty } from "@/lib/types";
import { useWorkflowActor } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-workflow-actor";
import { propertiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";
import { useIsWorkflowRunning } from "@/routes/_protected.workspaces/$workspaceId/-queries/workspace";
import { useWorkspaceStore } from "@/routes/_protected.workspaces/$workspaceId/-store";
import { sortProperty } from "@/routes/_protected.workspaces/$workspaceId/-utils";

const isSelectFieldOutdated = (
  property: WorkspaceProperty,
  field: WorkspaceField | undefined,
) => {
  if (property.tool.type !== "manual-input") {
    return false;
  }

  const propertyContent = property.content;
  const fieldContent = field?.content;

  if (
    propertyContent.type === "single-select" &&
    fieldContent?.type === "single-select"
  ) {
    const match = propertyContent.options.find(
      (option) => option.value === fieldContent.value,
    );

    return !match;
  }

  if (
    propertyContent.type === "multi-select" &&
    fieldContent?.type === "multi-select"
  ) {
    return fieldContent.value.some(
      (value) =>
        !propertyContent.options.some((option) => option.value === value),
    );
  }

  return false;
};

type CanStartWorkflowProps = {
  properties: WorkspaceProperty[];
  rowSelection: Record<string, boolean>;
};

type CanStartWorkflowResult = Result<
  void,
  | "all-manual-inputs"
  | "no-fields-to-process"
  | "manual-input-field-empty"
  | "select-field-outdated"
>;

const canStartWorkflow = ({
  properties,
  rowSelection,
}: CanStartWorkflowProps): CanStartWorkflowResult => {
  const manualInputProperties = properties.filter(
    (p) => p.tool.type === "manual-input",
  );

  if (manualInputProperties.length === properties.length) {
    return Result.err("all-manual-inputs");
  }

  const entities = useWorkspaceStore.getState().getEntities(rowSelection);

  for (const entity of entities) {
    for (const property of manualInputProperties) {
      const field = entity.fields[property.id];

      if (isSelectFieldOutdated(property, field)) {
        return Result.err("select-field-outdated");
      }
    }
  }

  for (const entity of entities) {
    for (const property of properties) {
      if (property.status !== "fresh") {
        return Result.ok();
      }

      const field = entity.fields[property.id];

      if (
        !field ||
        field?.content.type === "error" ||
        field?.content.type === "pending"
      ) {
        return Result.ok();
      }
    }
  }

  return Result.err("no-fields-to-process");
};

type RunButtonProps = {
  workspaceId: string;
};

export const RunWorkflowButton = ({ workspaceId }: RunButtonProps) => {
  const t = useTranslations();
  const posthog = usePostHog();
  const workflowActor = useWorkflowActor(workspaceId);
  const isWorkflowRunning = useIsWorkflowRunning();
  const [rowSelection, sorting] = useSearch({
    from: "/_protected/workspaces/$workspaceId/",
    select: (s) => [s.rowSelection, s.sorting] as const,
  });
  const { data: properties } = useSuspenseQuery(propertiesOptions(workspaceId));
  const runWorkflow = useMutation({
    mutationFn: async () => {
      const state = useWorkspaceStore.getState();
      let entities = state.getEntities(rowSelection);

      const sortItem = sorting.at(0);
      if (sortItem) {
        entities = entities.toSorted((a, b) => {
          const rowA = { original: a };
          const rowB = { original: b };
          const result = sortProperty(rowA, rowB, sortItem.id);
          return sortItem.desc ? -result : result;
        });
      }

      const entityIds = entities.map((entity) => entity.entityId);

      const result = await workflowActor.connection?.startWorkflow({
        workspaceId,
        entityIds,
      });

      if (result?.status !== "started") {
        throw new Error("Failed to start workflow");
      }
    },
    onError: (error) => {
      captureError(posthog, error);
    },
  });

  return (
    <Button
      disabled={runWorkflow.isPending || isWorkflowRunning}
      onClick={() => {
        const toastId = toastManager.add({
          type: "loading",
          title: t("workspaces.workflow.starting"),
        });

        const result = canStartWorkflow({ properties, rowSelection });

        if (Result.isOk(result)) {
          runWorkflow.mutate(undefined, {
            onSuccess: () => {
              toastManager.update(toastId, {
                type: "success",
                title: t("workspaces.workflow.startedSuccessfully"),
              });
            },
            onError: () => {
              toastManager.update(toastId, {
                type: "error",
                title: t("errors.actionFailed"),
              });
            },
          });
          return;
        }

        const error = result.error;

        switch (error) {
          case "all-manual-inputs": {
            toastManager.update(toastId, {
              type: "warning",
              title: t("workspaces.workflow.allManualInputsTitle"),
              description: t("workspaces.workflow.allManualInputsDescription"),
            });
            break;
          }
          case "select-field-outdated": {
            toastManager.update(toastId, {
              type: "warning",
              title: t("workspaces.workflow.someFieldsOutdatedTitle"),
              description: t(
                "workspaces.workflow.someFieldsOutdatedDescription",
              ),
            });
            break;
          }
          default: {
            toastManager.update(toastId, {
              type: "info",
              title: t("workspaces.workflow.noFieldsToProcess"),
            });
            break;
          }
        }
      }}
      size="sm"
    >
      <CircleFadingArrowUpIcon />
      {t("common.run")}
    </Button>
  );
};
