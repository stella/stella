import { useCallback, useEffect, useRef, useState } from "react";

import { toastManager } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { TOOLBAR_ROW_HEIGHT } from "@/lib/consts";
import type { EntityField, EntityKind, WorkspaceProperty } from "@/lib/types";
import { CreateProperty } from "@/routes/_protected.workspaces/$workspaceId/-components/create-property";
import { EditableField } from "@/routes/_protected.workspaces/$workspaceId/-components/editable-field";
import { PeekJustification } from "@/routes/_protected.workspaces/$workspaceId/-components/peek/peek-justification";
import { useStartWorkflow } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-start-workflow";
import {
  entitiesKeys,
  entityOptions,
} from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import { propertiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";
import { useIsWorkflowRunning } from "@/routes/_protected.workspaces/$workspaceId/-queries/workspace";
import { useWorkspaceStore } from "@/routes/_protected.workspaces/$workspaceId/-store";

type AiFieldClickArgs = {
  fieldId: string;
  propertyId: string;
};

type EntityMetadataPanelProps = {
  workspaceId: string;
  entityId: string;
  currentFilePropertyId?: string | null;
  /** Field id of the file this panel is anchored to. Used to scope
   *  inline justification citations to the visible PDF. */
  fileFieldId?: string | null;
  /** When set, the matching AI field is highlighted as active and
   *  its long-form justification renders inline below the value. */
  activeJustificationFieldId?: string | null;
  /** Called when a user clicks an AI-extracted field. Used by the
   *  parent to drive the PDF justification (bbox highlights). */
  onAiFieldClick?: (args: AiFieldClickArgs) => void;
};

type EntityMetadataContentProps = {
  workspaceId: string;
  entityId: string;
  currentFilePropertyId: string | null;
  fileFieldId: string | null;
  activeJustificationFieldId: string | null;
  onAiFieldClick: ((args: AiFieldClickArgs) => void) | undefined;
  entity: {
    kind: EntityKind;
    entityId: string;
    fields: EntityField[];
  };
};

type FieldInfoRow = {
  id: string;
  propertyId: string;
  content: EntityField["content"] | undefined;
};

export const EntityMetadataPanel = ({
  workspaceId,
  entityId,
  currentFilePropertyId = null,
  fileFieldId = null,
  activeJustificationFieldId = null,
  onAiFieldClick,
}: EntityMetadataPanelProps) => {
  const { data: entity } = useSuspenseQuery(
    entityOptions(workspaceId, entityId),
  );

  return (
    <EntityMetadataContent
      activeJustificationFieldId={activeJustificationFieldId}
      currentFilePropertyId={currentFilePropertyId}
      entity={entity}
      entityId={entityId}
      fileFieldId={fileFieldId}
      onAiFieldClick={onAiFieldClick}
      workspaceId={workspaceId}
    />
  );
};

const EntityMetadataContent = ({
  workspaceId,
  currentFilePropertyId,
  fileFieldId,
  activeJustificationFieldId,
  onAiFieldClick,
  entity,
}: EntityMetadataContentProps) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const startWorkflow = useStartWorkflow(workspaceId);
  const isWorkflowRunning = useIsWorkflowRunning(workspaceId);
  const sawWorkflowRunning = useRef(false);
  const { data: properties } = useSuspenseQuery(propertiesOptions(workspaceId));
  const [optimisticProperties, setOptimisticProperties] = useState<
    WorkspaceProperty[]
  >([]);
  const activeJustification = useWorkspaceStore((s) =>
    activeJustificationFieldId
      ? (s.justifications.find(
          (j) => j.fieldId === activeJustificationFieldId,
        ) ?? null)
      : null,
  );

  const refreshEntityFields = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: entitiesKeys.all(workspaceId),
    });
    void queryClient.invalidateQueries({
      queryKey: propertiesOptions(workspaceId).queryKey,
    });
  }, [queryClient, workspaceId]);

  useEffect(() => {
    if (isWorkflowRunning) {
      sawWorkflowRunning.current = true;
      return;
    }

    if (!sawWorkflowRunning.current) {
      return;
    }

    sawWorkflowRunning.current = false;
    refreshEntityFields();
  }, [isWorkflowRunning, refreshEntityFields]);

  const entityFieldPropertyIds = new Set(
    entity.fields.map((field) => field.propertyId),
  );
  const entityFieldPropertyIdsKey = [...entityFieldPropertyIds]
    .toSorted()
    .join(",");

  useEffect(() => {
    const currentFieldPropertyIds = new Set(
      entityFieldPropertyIdsKey.split(",").filter((id) => id.length > 0),
    );
    setOptimisticProperties((prev) =>
      prev.every((property) => !currentFieldPropertyIds.has(property.id))
        ? prev
        : prev.filter((property) => !currentFieldPropertyIds.has(property.id)),
    );
  }, [entityFieldPropertyIdsKey]);

  const propertyIds = new Set(properties.map((property) => property.id));
  const visibleProperties = [
    ...properties,
    ...optimisticProperties.filter((property) => !propertyIds.has(property.id)),
  ];
  const optimisticFields = optimisticProperties.flatMap((property) => {
    if (entityFieldPropertyIds.has(property.id)) {
      return [];
    }

    return [
      {
        id: `optimistic:${property.id}`,
        propertyId: property.id,
        content:
          property.tool.type === "ai-model"
            ? ({
                type: "pending",
                version: 1,
              } satisfies EntityField["content"])
            : undefined,
      },
    ];
  }) satisfies FieldInfoRow[];

  const propertyIndex = new Map(visibleProperties.map((p, i) => [p.id, i]));
  const visibleFields: FieldInfoRow[] = [...entity.fields, ...optimisticFields]
    .filter((field) => field.content?.type !== "file")
    .toSorted(
      (a, b) =>
        (propertyIndex.get(a.propertyId) ?? Infinity) -
        (propertyIndex.get(b.propertyId) ?? Infinity),
    );

  const handleExtractionCreated = ({
    mode,
    extractionScope,
    property,
  }: {
    mode: "ai" | "manual";
    extractionScope?: "file" | "matter";
    property: WorkspaceProperty;
  }) => {
    setOptimisticProperties((prev) => {
      if (prev.some((item) => item.id === property.id)) {
        return prev;
      }

      return [...prev, property];
    });

    if (mode !== "ai") {
      return;
    }

    const workflowArgs =
      extractionScope === "file" ? { entityIds: [entity.entityId] } : undefined;

    refreshEntityFields();

    void startWorkflow(workflowArgs).then((result) => {
      if (result === undefined) {
        toastManager.add({
          title: t("errors.actionFailed"),
          type: "error",
        });
        return;
      }

      refreshEntityFields();
    });
  };

  const extractionAction = (
    <CreateProperty
      extractionContext={{
        entityId: entity.entityId,
        filePropertyId: currentFilePropertyId,
      }}
      onCreated={handleExtractionCreated}
      triggerVariant="panel"
      workspaceId={workspaceId}
    />
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {visibleFields.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
            <span className="text-muted-foreground text-sm">
              {t("workspaces.noFieldsToView")}
            </span>
          </div>
        ) : (
          <div className="flex flex-col gap-px p-2">
            {visibleFields.map((field) => {
              const property = visibleProperties.find(
                (p) => p.id === field.propertyId,
              );
              if (!property) {
                return null;
              }
              const isPending = field.content?.type === "pending";
              const isAiField = property.tool.type === "ai-model";
              const canJustify =
                isAiField &&
                onAiFieldClick !== undefined &&
                field.content !== undefined &&
                field.content.type !== "pending" &&
                field.content.type !== "error";
              const isActive =
                isAiField && field.id === activeJustificationFieldId;
              const handleJustifyClick = canJustify
                ? () =>
                    onAiFieldClick({
                      fieldId: field.id,
                      propertyId: field.propertyId,
                    })
                : undefined;
              const fieldBody = (
                <>
                  <span
                    className={cn(
                      "text-muted-foreground text-xs font-medium",
                      isPending && "opacity-60",
                    )}
                  >
                    {property.name}
                  </span>
                  <EditableField
                    content={field.content}
                    entityKind={entity.kind}
                    entityId={entity.entityId}
                    property={property}
                    propertyId={field.propertyId}
                    readonly={isAiField}
                    workspaceId={workspaceId}
                  />
                </>
              );
              if (handleJustifyClick) {
                return (
                  <div
                    className={cn(
                      "rounded-md transition-colors",
                      isActive && "bg-accent",
                    )}
                    key={field.id + field.propertyId}
                  >
                    <button
                      aria-pressed={isActive}
                      className={cn(
                        "flex w-full flex-col gap-1 rounded-md px-2 py-2 text-start transition-colors",
                        !isActive && "hover:bg-accent",
                      )}
                      onClick={handleJustifyClick}
                      type="button"
                    >
                      {fieldBody}
                    </button>
                    {isActive &&
                      activeJustification &&
                      fileFieldId !== null && (
                        <div className="text-muted-foreground border-t-accent-foreground/10 max-h-48 overflow-y-auto border-t px-2 pt-2 pb-2 text-xs">
                          <PeekJustification
                            activeFileFieldId={fileFieldId}
                            justification={activeJustification}
                          />
                        </div>
                      )}
                  </div>
                );
              }
              return (
                <div
                  className="flex flex-col gap-1 rounded-md px-2 py-2"
                  key={field.id + field.propertyId}
                >
                  {fieldBody}
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div className={cn("flex shrink-0 border-t", TOOLBAR_ROW_HEIGHT)}>
        {extractionAction}
      </div>
    </div>
  );
};
