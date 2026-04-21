import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import { autoScrollForElements } from "@atlaskit/pragmatic-drag-and-drop-auto-scroll/element";
import { autoScrollForExternal } from "@atlaskit/pragmatic-drag-and-drop-auto-scroll/external";
import { extractClosestEdge } from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge";
import type { Edge } from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge";
import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import { monitorForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { KanbanIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import type { OptionColor } from "@stella/api/types";
import { toastManager } from "@stella/ui/components/toast";

import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import type {
  EntityKind,
  WorkspaceEntity,
  WorkspaceProperty,
  WorkspaceView,
} from "@/lib/types";
// -- Auto-scrolling board container with forgiving column drop --
import { COLUMN_DRAG_TYPE } from "@/routes/_protected.workspaces/$workspaceId/-components/drag-constants";
import { EmptyState } from "@/routes/_protected.workspaces/$workspaceId/-components/empty-state";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import { KanbanColumn } from "@/routes/_protected.workspaces/$workspaceId/-components/kanban/kanban-column";
import { optionColorsMap } from "@/routes/_protected.workspaces/$workspaceId/-components/utils";
import {
  uploadFileEntitiesBatched,
  useBatchUploadLabels,
} from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-create-file-entities";
import { useStartWorkflow } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-start-workflow";
import {
  useCreateEntities,
  useDeleteEntities,
  useRenameEntity,
  useUpsertField,
} from "@/routes/_protected.workspaces/$workspaceId/-mutations/entities";
import { useUpdateProperty } from "@/routes/_protected.workspaces/$workspaceId/-mutations/properties";
import {
  entitiesKeys,
  useEntitiesOptions,
} from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import { propertiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";
import {
  getFieldValue,
  getInternalPropertyId,
  resolveKanbanGroupBy,
} from "@/routes/_protected.workspaces/$workspaceId/-utils";

type KanbanViewProps = {
  view: WorkspaceView;
  workspaceId: string;
};

export const KanbanView = ({ view, workspaceId }: KanbanViewProps) => {
  const t = useTranslations();
  const labels = useBatchUploadLabels();
  const analytics = useAnalytics();
  const { data: properties } = useSuspenseQuery(propertiesOptions(workspaceId));
  const upsertField = useUpsertField();
  const renameEntity = useRenameEntity();
  const updateProperty = useUpdateProperty();
  const createEntities = useCreateEntities();
  const deleteEntities = useDeleteEntities();
  const startWorkflow = useStartWorkflow();
  const queryClient = useQueryClient();
  const hasAIProperties = properties.some((p) => p.tool.type === "ai-model");
  const [hiddenGroups, setHiddenGroups] = useState(new Set());
  const [localColumnOrder, setLocalColumnOrder] = useState<string[]>([]);

  const handleCreate = async (kind: EntityKind) => {
    if (kind === "task") {
      const response = await api.tasks({ workspaceId }).put({
        queryKey: entitiesKeys.all(workspaceId),
        name: t("tasks.untitled"),
      });

      const entityId = response.data?.entityId;
      if (response.error || !entityId) {
        toastManager.add({
          title: t("errors.actionFailed"),
          type: "error",
        });
        return;
      }

      toastManager.add({
        title: t("success.taskCreated"),
        type: "success",
      });
      useInspectorStore.getState().openTask(entityId, "", true);
      return;
    }

    createEntities.mutate(
      {
        workspaceId,
        type: "manual-input",
        kind,
      },
      {
        onSuccess: () => {
          toastManager.add({
            title: t("success.documentCreated"),
            type: "success",
          });
        },
        onError: () => {
          toastManager.add({
            title: t("errors.actionFailed"),
            type: "error",
          });
        },
      },
    );
  };

  const { hiddenProperties } = view.layout;
  const configuredGroupBy =
    view.layout.type === "kanban" ? (view.layout.groupByPropertyId ?? "") : "";

  // Reset local column order when the groupBy property changes so stale
  // column positions from the previous grouping don't leak through.
  useEffect(() => {
    setLocalColumnOrder([]);
  }, [configuredGroupBy]);

  const resolvedGroupBy = useMemo(
    () => resolveKanbanGroupBy(configuredGroupBy, properties),
    [configuredGroupBy, properties],
  );

  // Fields to show on each card: all properties minus hidden ones.
  const allPropertyIds = properties.map((p) => p.id);
  const allFieldIds = [
    ...allPropertyIds,
    getInternalPropertyId("status"),
    getInternalPropertyId("priority"),
    getInternalPropertyId("due-date"),
    getInternalPropertyId("created-by"),
    getInternalPropertyId("updated-at"),
    getInternalPropertyId("version"),
  ];
  const cardFields = allFieldIds.filter(
    (id) =>
      id !== resolvedGroupBy &&
      id !== getInternalPropertyId("kind") &&
      !hiddenProperties.includes(id),
  );

  const groupByPropertyId = resolvedGroupBy;
  const isStatusGrouping =
    groupByPropertyId === getInternalPropertyId("status");
  const isBuiltInGrouping =
    !isStatusGrouping &&
    (groupByPropertyId === getInternalPropertyId("kind") ||
      groupByPropertyId === getInternalPropertyId("created-by"));
  const groupByProperty =
    isBuiltInGrouping || isStatusGrouping
      ? null
      : properties.find((p) => p.id === groupByPropertyId);

  const { filters, sorts } = view.layout;

  const { data: entityData } = useSuspenseQuery(
    useEntitiesOptions({
      workspaceId,
      filters,
      sorts,
      page: 1,
    }),
  );

  const entities = useMemo(
    () => entityData.entities.filter((e) => e.kind === "task"),
    [entityData.entities],
  );

  // Mutation for changing task status via kanban drag-drop
  const updateTaskStatus = useMutation({
    mutationFn: async ({
      taskId,
      status,
    }: {
      taskId: string;
      status: string;
    }) => {
      const response = await api.tasks({ workspaceId }).patch({
        queryKey: entitiesKeys.all(workspaceId),
        taskId,
        status,
      });
      if (response.error) {
        toastManager.add({
          title: t("errors.actionFailed"),
          type: "error",
        });
      }
      return response.data;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: entitiesKeys.all(workspaceId),
      });
    },
  });

  // No group-by selected at all
  if (!isBuiltInGrouping && !isStatusGrouping && !groupByProperty) {
    return (
      <EmptyState
        hint={t("workspaces.kanban.usePropertyHint")}
        icon={KanbanIcon}
        message={t("workspaces.kanban.selectPropertyHint")}
      />
    );
  }

  // -- Unified grouping: resolve options, then render one board --

  const statusLabels: Record<string, string> = isStatusGrouping
    ? Object.fromEntries(
        TASK_STATUS_ORDER.map((s) => [
          s,
          // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
          t(`tasks.statusValues.${s}` as "tasks.statusValues.open"),
        ]),
      )
    : {};

  const options: GroupOption[] = isStatusGrouping
    ? getStatusGroupOptions(statusLabels)
    : isBuiltInGrouping
      ? getBuiltInGroupOptions(
          entities,
          groupByPropertyId,
          t("workspaces.kanban.unknown"),
        )
      : groupByProperty && isGroupableProperty(groupByProperty)
        ? getGroupOptions(groupByProperty)
        : [];

  const groups = isStatusGrouping
    ? groupEntitiesByStatus(entities, options, t("common.uncategorized"))
    : groupEntities(
        entities,
        groupByPropertyId,
        options,
        t("common.uncategorized"),
      );

  const handleDrop = (targetValue: string | null, entityId: string) => {
    if (isStatusGrouping && targetValue !== null) {
      updateTaskStatus.mutate({ taskId: entityId, status: targetValue });
      return;
    }
    if (isBuiltInGrouping) {
      return;
    }
    const content = {
      version: 1 as const,
      type: "single-select" as const,
      value: targetValue,
    };
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
          void startWorkflow({ entityIds: [entityId] });
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

    const results = await uploadFileEntitiesBatched({
      files,
      workspaceId,
      propertyId: filePropertyId,
      labels,
      onError: (error) => analytics.captureError(error),
    });

    if (columnValue === null) {
      return;
    }

    for (const result of results) {
      const { entityId } = result;
      const content = {
        version: 1 as const,
        type: "single-select" as const,
        value: columnValue,
      };

      upsertField.mutate({
        workspaceId,
        propertyId: groupByPropertyId,
        entityId,
        content,
      });
    }
  };

  const handleChangeColor = groupByProperty
    ? (optionValue: string, newColor: OptionColor) => {
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
      }
    : null;

  const handleRenameColumn = groupByProperty
    ? (oldValue: string, newValue: string) => {
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

        const affected = entities.filter((e) => {
          const val = getFieldValue(e.fields[groupByPropertyId]);
          return val === oldValue;
        });
        for (const entity of affected) {
          upsertField.mutate({
            workspaceId,
            propertyId: groupByPropertyId,
            entityId: entity.entityId,
            content: {
              version: 1 as const,
              type: "single-select" as const,
              value: newValue,
            },
          });
        }
      }
    : null;

  const handleHideColumn = (value: string) => {
    setHiddenGroups((prev) => {
      const next = new Set(prev);
      next.add(value);
      return next;
    });
  };

  const handleDeleteAll = (entityIds: string[]) => {
    deleteEntities.mutate({ workspaceId, entityIds });
  };

  const handleRenameEntity = (entityId: string, newName: string) => {
    renameEntity.mutate({ workspaceId, entityId, name: newName });
  };

  const handleReorderColumn = (
    sourceValue: string,
    targetValue: string,
    edge: Edge | null,
  ) => {
    if (
      groupByProperty &&
      (groupByProperty.content.type === "single-select" ||
        groupByProperty.content.type === "multi-select")
    ) {
      const opts = [...groupByProperty.content.options];
      const srcIdx = opts.findIndex((o) => o.value === sourceValue);
      const tgtIdx = opts.findIndex((o) => o.value === targetValue);
      if (srcIdx === -1 || tgtIdx === -1) {
        return;
      }
      const insertBeforeTarget = edge === "left";
      const rawDestIdx = insertBeforeTarget ? tgtIdx : tgtIdx + 1;
      const destIdx = srcIdx < rawDestIdx ? rawDestIdx - 1 : rawDestIdx;
      if (destIdx === srcIdx) {
        return;
      }
      const [moved] = opts.splice(srcIdx, 1);
      if (!moved) {
        return;
      }
      opts.splice(destIdx, 0, moved);
      updateProperty.mutate({
        workspaceId,
        propertyId: groupByPropertyId,
        name: groupByProperty.name,
        content: { ...groupByProperty.content, options: opts },
        tool: groupByProperty.tool,
      });
      return;
    }

    // For status/built-in: reorder locally
    setLocalColumnOrder((prev) => {
      const current = prev.length > 0 ? prev : groups.map((g) => g.value ?? "");
      const srcIdx = current.indexOf(sourceValue);
      const tgtIdx = current.indexOf(targetValue);
      if (srcIdx === -1 || tgtIdx === -1) {
        return prev;
      }
      const next = [...current];
      const insertBeforeTarget = edge === "left";
      const rawDestIdx = insertBeforeTarget ? tgtIdx : tgtIdx + 1;
      const destIdx = srcIdx < rawDestIdx ? rawDestIdx - 1 : rawDestIdx;
      if (destIdx === srcIdx) {
        return prev;
      }
      const [moved] = next.splice(srcIdx, 1);
      if (!moved) {
        return prev;
      }
      next.splice(destIdx, 0, moved);
      return next;
    });
  };

  const filteredGroups = groups.filter(
    (g) => g.value === null || !hiddenGroups.has(g.value),
  );

  // Apply local column order if set
  const visibleGroups =
    localColumnOrder.length > 0
      ? localColumnOrder
          .map((v) => filteredGroups.find((g) => g.value === v))
          .filter((g): g is EntityGroup => g !== undefined)
          .concat(
            filteredGroups.filter(
              (g) => g.value === null || !localColumnOrder.includes(g.value),
            ),
          )
      : filteredGroups;

  return (
    <KanbanBoard onReorderColumn={handleReorderColumn}>
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
              value !== null && handleChangeColor
                ? (c) => handleChangeColor(value, c)
                : undefined
            }
            onDeleteAll={
              value !== null
                ? () => handleDeleteAll(group.entities.map((e) => e.entityId))
                : undefined
            }
            onCreate={(kind) => {
              handleCreate(kind).catch(() => {
                // Error handled inside handleCreate
              });
            }}
            onDrop={(entityId) => handleDrop(value, entityId)}
            // eslint-disable-next-line typescript/no-misused-promises
            onFileUpload={async (files) => await handleFileUpload(value, files)}
            onHideColumn={
              value !== null ? () => handleHideColumn(value) : undefined
            }
            onRenameColumn={
              value !== null && handleRenameColumn
                ? (newName) => handleRenameColumn(value, newName)
                : undefined
            }
            onRenameEntity={handleRenameEntity}
            onReorderColumn={handleReorderColumn}
            optionColor={group.optionColor}
            properties={properties}
            taskOnly={isStatusGrouping}
            title={group.label}
            workspaceId={workspaceId}
          />
        );
      })}
    </KanbanBoard>
  );
};

type ColumnDragPosition = {
  sourceValue: string;
  targetValue: string;
  edge: Edge;
};

type KanbanBoardProps = {
  children: ReactNode;
  onReorderColumn?: (
    sourceValue: string,
    targetValue: string,
    edge: Edge | null,
  ) => void;
};

const KanbanBoard = ({ children, onReorderColumn }: KanbanBoardProps) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Track the last valid drop position so drops in the
  // gap between columns still work (monitors always fire).
  const lastPosition = useRef<ColumnDragPosition | null>(null);
  const onReorderRef = useRef(onReorderColumn);
  onReorderRef.current = onReorderColumn;

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) {
      return undefined;
    }
    return combine(
      autoScrollForElements({
        element: el,
        getAllowedAxis: () => "horizontal",
      }),
      autoScrollForExternal({
        element: el,
        getAllowedAxis: () => "horizontal",
      }),
      monitorForElements({
        canMonitor: ({ source }) => source.data.type === COLUMN_DRAG_TYPE,
        onDragStart: () => {
          lastPosition.current = null;
        },
        onDrag: ({ source, location }) => {
          const target = location.current.dropTargets.at(0);
          if (!target) {
            return;
          }
          const edge = extractClosestEdge(target.data);
          const targetValue = target.data.columnValue;
          const sourceValue = source.data.columnValue;
          if (
            edge &&
            typeof targetValue === "string" &&
            typeof sourceValue === "string" &&
            targetValue !== sourceValue
          ) {
            lastPosition.current = {
              sourceValue,
              targetValue,
              edge,
            };
          }
        },
        onDrop: () => {
          const pos = lastPosition.current;
          lastPosition.current = null;
          if (pos) {
            onReorderRef.current?.(pos.sourceValue, pos.targetValue, pos.edge);
          }
        },
      }),
    );
  }, []);

  return (
    <div className="flex h-full gap-4 overflow-x-auto p-4" ref={scrollRef}>
      {children}
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
  color?: string | undefined;
  colorBg?: string | undefined;
  optionColor?: OptionColor | undefined;
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

/** All task statuses in the order they should appear as kanban columns. */
const TASK_STATUS_ORDER = [
  "open",
  "in_progress",
  "in_review",
  "done",
  "cancelled",
] as const;

/** Map task status to kanban option colors. */
const STATUS_OPTION_COLORS: Record<string, OptionColor> = {
  open: "gray",
  in_progress: "blue",
  in_review: "amber",
  done: "green",
  cancelled: "red",
};

/** Build GroupOption[] for task status kanban. */
const getStatusGroupOptions = (labels: Record<string, string>): GroupOption[] =>
  TASK_STATUS_ORDER.map((status) => {
    const optColor = STATUS_OPTION_COLORS[status] ?? "gray";
    return {
      value: status,
      label: labels[status] ?? status,
      color: optionColorsMap[optColor]?.color,
      colorBg: optionColorsMap[optColor]?.background,
      optionColor: optColor,
    };
  });

/** Group entities by status, pre-seeding all status columns. */
const groupEntitiesByStatus = (
  entities: WorkspaceEntity[],
  options: GroupOption[],
  uncategorizedLabel: string,
): EntityGroup[] => {
  const grouped = new Map<string | null, WorkspaceEntity[]>();
  for (const opt of options) {
    grouped.set(opt.value, []);
  }
  grouped.set(null, []);

  for (const entity of entities) {
    const key = entity.status ?? "open";
    const bucket = grouped.get(key);
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

/** Build GroupOption[] for read-only built-in groupings (kind, created-by). */
const getBuiltInGroupOptions = (
  entities: WorkspaceEntity[],
  mode: string,
  unknownLabel: string,
): GroupOption[] => {
  const seen = new Set<string>();
  for (const entity of entities) {
    const key =
      mode === getInternalPropertyId("kind")
        ? entity.kind
        : (entity.createdBy ?? "");
    seen.add(key);
  }

  return [...seen].map((key) => ({
    value: key,
    label:
      mode === getInternalPropertyId("kind")
        ? key.charAt(0).toUpperCase() + key.slice(1)
        : key || unknownLabel,
  }));
};
