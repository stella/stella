import { usePostHog } from "@posthog/react";
import { useMutation, useSuspenseQuery } from "@tanstack/react-query";
import { Result } from "better-result";
import { CircleFadingArrowUpIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stella/ui/components/button";
import { toastManager } from "@stella/ui/components/toast";

import { captureError } from "@/lib/posthog/utils";
import type {
  WorkspaceEntity,
  WorkspaceField,
  WorkspaceProperty,
} from "@/lib/types";
import { useTableStore } from "@/routes/_protected.workspaces/$workspaceId/-hooks/table-store";
import { useActiveView } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-active-view";
import { useWorkflowActor } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-workflow-actor";
import { entitiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import { propertiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";
import { useIsWorkflowRunning } from "@/routes/_protected.workspaces/$workspaceId/-queries/workspace";

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
  entities: WorkspaceEntity[];
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
  entities,
}: CanStartWorkflowProps): CanStartWorkflowResult => {
  const manualInputProperties = properties.filter(
    (p) => p.tool.type === "manual-input",
  );

  if (manualInputProperties.length === properties.length) {
    return Result.err("all-manual-inputs");
  }

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
        field === undefined ||
        field === null ||
        field.content.type === "error" ||
        field.content.type === "pending"
      ) {
        return Result.ok();
      }
    }
  }

  return Result.err("no-fields-to-process");
};

type RunButtonProps = {
  workspaceId: string;
  viewId: string;
};

export const RunWorkflowButton = ({ workspaceId, viewId }: RunButtonProps) => {
  const t = useTranslations();
  const posthog = usePostHog();
  const workflowActor = useWorkflowActor(workspaceId);
  const isWorkflowRunning = useIsWorkflowRunning();
  const rowSelection = useTableStore((s) => s.rowSelection.get(viewId)) ?? {};
  const { data: properties } = useSuspenseQuery(propertiesOptions(workspaceId));
  const activeView = useActiveView();
  const { data: entityData } = useSuspenseQuery(entitiesOptions(activeView));
  const runWorkflow = useMutation({
    mutationFn: async () => {
      const entityIds = Object.keys(rowSelection);

      const result = await workflowActor.connection?.startWorkflow({
        workspaceId,
        entityIds,
        entityIdsOrder: entityData.entities.map((e) => e.entityId),
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

        const result = canStartWorkflow({
          properties,
          entities: entityData.entities,
        });

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

        // oxlint-disable-next-line typescript/switch-exhaustiveness-check
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
