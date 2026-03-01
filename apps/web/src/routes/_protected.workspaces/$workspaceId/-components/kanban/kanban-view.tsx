import { useMemo, useState } from "react";
import { usePostHog } from "@posthog/react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Result } from "better-result";
import { KanbanIcon } from "lucide-react";
import { useTranslations } from "use-intl";
import { useShallow } from "zustand/shallow";

import type { OptionColor } from "@stella/api/types";
import { toastManager } from "@stella/ui/components/toast";

import { captureError } from "@/lib/posthog/utils";
import type {
  WorkspaceEntity,
  WorkspaceProperty,
  WorkspaceView,
} from "@/lib/types";
import { EmptyState } from "@/routes/_protected.workspaces/$workspaceId/-components/empty-state";
import { KanbanColumn } from "@/routes/_protected.workspaces/$workspaceId/-components/kanban/kanban-column";
import { optionColorsMap } from "@/routes/_protected.workspaces/$workspaceId/-components/utils";
import { uploadFileEntity } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-create-file-entities";
import { useWorkflowActor } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-workflow-actor";
import {
  useDeleteEntities,
  useRenameEntity,
  useUpsertField,
} from "@/routes/_protected.workspaces/$workspaceId/-mutations/entities";
import { useUpdateProperty } from "@/routes/_protected.workspaces/$workspaceId/-mutations/properties";
import { propertiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";
import { useWorkspaceStore } from "@/routes/_protected.workspaces/$workspaceId/-store";
import {
  applyFilters,
  applySorts,
  getFieldValue,
  resolveKanbanGroupBy,
} from "@/routes/_protected.workspaces/$workspaceId/-utils";

type KanbanViewProps = {
  view: WorkspaceView;
  workspaceId: string;
};

export const KanbanView = ({ view, workspaceId }: KanbanViewProps) => {
  const t = useTranslations();
  const posthog = usePostHog();
  const data = useWorkspaceStore(useShallow((s) => s.data));
  const setFieldData = useWorkspaceStore((s) => s.setFieldData);
  const { data: properties } = useSuspenseQuery(propertiesOptions(workspaceId));
  const upsertField = useUpsertField();
  const renameEntity = useRenameEntity();
  const setEntityName = useWorkspaceStore((s) => s.setEntityName);
  const updateProperty = useUpdateProperty();
  const deleteEntities = useDeleteEntities();
  const workflowActor = useWorkflowActor(workspaceId);
  const hasAIProperties = properties.some((p) => p.tool.type === "ai-model");
  const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(new Set());

  const { visibleProperties } = view.config;
  const configuredGroupBy = view.config.kanban?.groupByPropertyId ?? "";

  const resolvedGroupBy = useMemo(
    () => resolveKanbanGroupBy(configuredGroupBy, properties),
    [configuredGroupBy, properties],
  );

  // Fields to show on each card: visible properties plus metadata.
  // Empty visibleProperties means "all visible".
  const allPropertyIds = properties.map((p) => p.id);
  const resolvedVisible =
    visibleProperties.length > 0
      ? visibleProperties
      : [...allPropertyIds, "__created_by__", "__updated_at__", "__version__"];
  const cardFields = resolvedVisible.filter(
    (id) => id !== resolvedGroupBy && id !== "__kind__",
  );

  const groupByPropertyId = resolvedGroupBy;
  const isBuiltInGrouping =
    groupByPropertyId === "__kind__" || groupByPropertyId === "__created_by__";
  const groupByProperty = isBuiltInGrouping
    ? null
    : properties.find((p) => p.id === groupByPropertyId);

  const { filters, sorts } = view.config;

  const entities = useMemo(() => {
    const filtered = applyFilters(data, filters);
    return applySorts(filtered, sorts);
  }, [data, filters, sorts]);

  // No group-by selected at all
  if (!isBuiltInGrouping && !groupByProperty) {
    return (
      <EmptyState
        hint={t("workspaces.kanban.usePropertyHint")}
        icon={KanbanIcon}
        message={t("workspaces.kanban.selectPropertyHint")}
      />
    );
  }

  // Property-based grouping (single-select)
  if (
    !isBuiltInGrouping &&
    groupByProperty &&
    isGroupableProperty(groupByProperty)
  ) {
    const options = getGroupOptions(groupByProperty);
    const groups = groupEntities(
      entities,
      groupByPropertyId,
      options,
      t("common.uncategorized"),
    );

    const handleDrop = (targetValue: string | null, entityId: string) => {
      const content = {
        version: 1 as const,
        type: "single-select" as const,
        value: targetValue,
      };

      setFieldData([{ propertyId: groupByPropertyId, entityId, content }]);

      upsertField.mutate(
        {
          workspaceId,
          propertyId: groupByPropertyId,
          entityId,
          content,
        },
        {
          onSuccess: () => {
            if (!hasAIProperties) {
              return;
            }
            const entity = entities.find((e) => e.entityId === entityId);
            if (entity?.kind === "folder") {
              return;
            }
            workflowActor.connection
              ?.startWorkflow({ workspaceId, entityIds: [entityId] })
              .catch((error) => {
                captureError(posthog, error);
                toastManager.add({
                  title: t("errors.failedToStartWorkflow"),
                  type: "error",
                });
              });
          },
        },
      );
    };

    const handleFileUpload = async (
      columnValue: string | null,
      files: File[],
    ) => {
      const filePropertyId = properties.find(
        (p) => p.content.type === "file",
      )?.id;

      if (!filePropertyId) {
        toastManager.add({
          title: t("workspaces.files.addFilePropertyToUpload"),
          type: "warning",
        });
        return;
      }

      const toastId = toastManager.add({
        type: "loading",
        title: t("workspaces.files.uploading"),
        description: t("workspaces.files.uploadingDescription"),
      });

      const results = await Promise.all(
        files.map((file) =>
          uploadFileEntity(file, workspaceId, filePropertyId),
        ),
      );

      const failed = results.find(Result.isError);
      if (failed) {
        toastManager.update(toastId, {
          type: "error",
          title: t("errors.actionFailed"),
          description: failed.error.message,
        });
        return;
      }

      toastManager.update(toastId, {
        type: "success",
        title: t("workspaces.files.uploadedSuccessfully"),
        description: undefined,
      });

      if (columnValue === null) {
        return;
      }

      for (const result of results) {
        if (!Result.isOk(result)) {
          continue;
        }

        const { entityId } = result.value;
        const content = {
          version: 1 as const,
          type: "single-select" as const,
          value: columnValue,
        };

        setFieldData([{ propertyId: groupByPropertyId, entityId, content }]);

        upsertField.mutate({
          workspaceId,
          propertyId: groupByPropertyId,
          entityId,
          content,
        });
      }
    };

    const handleChangeColor = (optionValue: string, newColor: OptionColor) => {
      if (
        groupByProperty.content.type !== "single-select" &&
        groupByProperty.content.type !== "multi-select"
      ) {
        return;
      }
      const updatedOptions = groupByProperty.content.options.map((opt) =>
        opt.value === optionValue ? { ...opt, color: newColor } : opt,
      );
      updateProperty.mutate({
        workspaceId,
        propertyId: groupByPropertyId,
        name: groupByProperty.name,
        content: { ...groupByProperty.content, options: updatedOptions },
        tool: groupByProperty.tool,
      });
    };

    const handleRenameColumn = (oldValue: string, newValue: string) => {
      if (
        groupByProperty.content.type !== "single-select" &&
        groupByProperty.content.type !== "multi-select"
      ) {
        return;
      }
      const updatedOptions = groupByProperty.content.options.map((opt) =>
        opt.value === oldValue ? { ...opt, value: newValue } : opt,
      );
      updateProperty.mutate({
        workspaceId,
        propertyId: groupByPropertyId,
        name: groupByProperty.name,
        content: { ...groupByProperty.content, options: updatedOptions },
        tool: groupByProperty.tool,
      });

      // Update all entities that had the old value
      const affected = entities.filter((e) => {
        const val = getFieldValue(e.fields[groupByPropertyId]);
        return val === oldValue;
      });
      for (const entity of affected) {
        const content = {
          version: 1 as const,
          type: "single-select" as const,
          value: newValue,
        };
        setFieldData([
          {
            propertyId: groupByPropertyId,
            entityId: entity.entityId,
            content,
          },
        ]);
        upsertField.mutate({
          workspaceId,
          propertyId: groupByPropertyId,
          entityId: entity.entityId,
          content,
        });
      }
    };

    const handleHideColumn = (value: string) => {
      setHiddenColumns((prev) => {
        const next = new Set(prev);
        next.add(value);
        return next;
      });
    };

    const handleDeleteAll = (entityIds: string[]) => {
      deleteEntities.mutate({ workspaceId, entityIds });
    };

    const handleRenameEntity = (entityId: string, newName: string) => {
      setEntityName(entityId, newName);
      renameEntity.mutate({
        workspaceId,
        entityId,
        name: newName,
      });
    };

    const handleReorderColumn = (sourceValue: string, targetValue: string) => {
      if (
        groupByProperty.content.type !== "single-select" &&
        groupByProperty.content.type !== "multi-select"
      ) {
        return;
      }
      const opts = [...groupByProperty.content.options];
      const srcIdx = opts.findIndex((o) => o.value === sourceValue);
      const tgtIdx = opts.findIndex((o) => o.value === targetValue);
      if (srcIdx === -1 || tgtIdx === -1) {
        return;
      }
      const [moved] = opts.splice(srcIdx, 1);
      const adjustedIdx = srcIdx < tgtIdx ? tgtIdx - 1 : tgtIdx;
      opts.splice(adjustedIdx, 0, moved);
      updateProperty.mutate({
        workspaceId,
        propertyId: groupByPropertyId,
        name: groupByProperty.name,
        content: { ...groupByProperty.content, options: opts },
        tool: groupByProperty.tool,
      });
    };

    const visibleGroups = groups.filter(
      (g) => g.value === null || !hiddenColumns.has(g.value),
    );

    return (
      <div className="flex h-full gap-4 overflow-x-auto p-4">
        {visibleGroups.map((group) => {
          const { value } = group;
          return (
            <KanbanColumn
              cardFields={cardFields}
              color={group.color}
              colorBg={group.colorBg}
              columnValue={value}
              entities={group.entities}
              key={value ?? "__uncategorized__"}
              onChangeColor={
                value !== null ? (c) => handleChangeColor(value, c) : undefined
              }
              onDeleteAll={
                value !== null
                  ? () => handleDeleteAll(group.entities.map((e) => e.entityId))
                  : undefined
              }
              onDrop={(entityId) => handleDrop(value, entityId)}
              onFileUpload={(files) => handleFileUpload(value, files)}
              onHideColumn={
                value !== null ? () => handleHideColumn(value) : undefined
              }
              onRenameColumn={
                value !== null
                  ? (newName) => handleRenameColumn(value, newName)
                  : undefined
              }
              onRenameEntity={handleRenameEntity}
              onReorderColumn={handleReorderColumn}
              optionColor={group.optionColor}
              properties={properties}
              title={group.label}
              workspaceId={workspaceId}
            />
          );
        })}
      </div>
    );
  }

  // Built-in grouping (kind / author): read-only columns
  const resolveBuiltInLabel = (key: string) => {
    if (groupByPropertyId === "__kind__") {
      return key.charAt(0).toUpperCase() + key.slice(1);
    }
    return key || t("workspaces.kanban.unknown");
  };
  const builtInGroups = groupByBuiltIn(
    entities,
    groupByPropertyId,
    resolveBuiltInLabel,
  );

  return (
    <div className="flex h-full gap-4 overflow-x-auto p-4">
      {builtInGroups.map((group) => (
        <KanbanColumn
          cardFields={cardFields}
          columnValue={null}
          entities={group.entities}
          key={group.label}
          onDrop={() => {
            // Built-in groupings are read-only
          }}
          properties={properties}
          title={group.label}
          workspaceId={workspaceId}
        />
      ))}
    </div>
  );
};

// -- Helpers --

const isGroupableProperty = (property: WorkspaceProperty) =>
  property.content.type === "single-select";

type GroupOption = {
  value: string;
  label: string;
  color?: string;
  colorBg?: string;
  optionColor?: OptionColor;
};

const getGroupOptions = (property: WorkspaceProperty): GroupOption[] => {
  if (
    property.content.type === "single-select" ||
    property.content.type === "multi-select"
  ) {
    return property.content.options.map((opt) => ({
      value: opt.value,
      label: opt.value,
      color: optionColorsMap[opt.color]?.color,
      colorBg: optionColorsMap[opt.color]?.background,
      optionColor: opt.color,
    }));
  }

  return [];
};

type EntityGroup = {
  value: string | null;
  label: string;
  color?: string;
  colorBg?: string;
  optionColor?: OptionColor;
  entities: WorkspaceEntity[];
};

const groupEntities = (
  entities: WorkspaceEntity[],
  propertyId: string,
  options: GroupOption[],
  uncategorizedLabel: string,
): EntityGroup[] => {
  const grouped = new Map<string | null, WorkspaceEntity[]>();

  for (const opt of options) {
    grouped.set(opt.value, []);
  }
  grouped.set(null, []);

  for (const entity of entities) {
    const value = getFieldValue(entity.fields[propertyId]);
    const normalizedValue = value === "" || value === null ? null : value;

    const bucket = grouped.get(normalizedValue);
    if (bucket) {
      bucket.push(entity);
    } else {
      grouped.get(null)?.push(entity);
    }
  }

  const result: EntityGroup[] = options.map((opt) => ({
    value: opt.value,
    label: opt.label,
    color: opt.color,
    colorBg: opt.colorBg,
    optionColor: opt.optionColor,
    entities: grouped.get(opt.value) ?? [],
  }));

  const uncategorized = grouped.get(null) ?? [];
  if (uncategorized.length > 0) {
    result.push({
      value: null,
      label: uncategorizedLabel,
      entities: uncategorized,
    });
  }

  return result;
};

type BuiltInGroup = {
  label: string;
  entities: WorkspaceEntity[];
};

const groupByBuiltIn = (
  entities: WorkspaceEntity[],
  mode: string,
  resolveLabel: (key: string) => string,
): BuiltInGroup[] => {
  const grouped = new Map<string, WorkspaceEntity[]>();

  for (const entity of entities) {
    const key = mode === "__kind__" ? entity.kind : (entity.createdBy ?? "");

    const bucket = grouped.get(key);
    if (bucket) {
      bucket.push(entity);
    } else {
      grouped.set(key, [entity]);
    }
  }

  return Array.from(grouped.entries()).map(([key, ents]) => ({
    label: resolveLabel(key),
    entities: ents,
  }));
};
