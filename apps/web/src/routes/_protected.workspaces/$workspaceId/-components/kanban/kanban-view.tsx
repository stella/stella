import { useEffectEvent, useMemo, useRef, useState } from "react";
import type { ComponentProps, ReactNode } from "react";

import { autoScrollForElements } from "@atlaskit/pragmatic-drag-and-drop-auto-scroll/element";
import { autoScrollForExternal } from "@atlaskit/pragmatic-drag-and-drop-auto-scroll/external";
import { extractClosestEdge } from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge";
import type { Edge } from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge";
import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import { monitorForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import {
  useMutation,
  useInfiniteQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { KanbanIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import type { OptionColor } from "@stll/api/types";
import { stellaToast } from "@stll/ui/components/toast";

import { useMountEffect } from "@/hooks/use-effect";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { toSafeId } from "@/lib/safe-id";
import type { EntityKind, WorkspaceView } from "@/lib/types";
// -- Auto-scrolling board container with forgiving column drop --
import { COLUMN_DRAG_TYPE } from "@/routes/_protected.workspaces/$workspaceId/-components/drag-constants";
import { EmptyState } from "@/routes/_protected.workspaces/$workspaceId/-components/empty-state";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import { KanbanColumn } from "@/routes/_protected.workspaces/$workspaceId/-components/kanban/kanban-column";
import {
  getEntityGroups,
  getKanbanGroupingPropertyId,
  resolveGroupOptions,
  resolveKanbanGrouping,
  TASK_STATUS_ORDER,
} from "@/routes/_protected.workspaces/$workspaceId/-components/kanban/kanban-view.logic";
import type { EntityGroup } from "@/routes/_protected.workspaces/$workspaceId/-components/kanban/kanban-view.logic";
import {
  uploadFileEntitiesBatched,
  useBatchUploadLabels,
} from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-create-file-entities";
import {
  useCreateEntities,
  useRenameEntity,
  useUpsertField,
} from "@/routes/_protected.workspaces/$workspaceId/-mutations/entities";
import { useUpdateProperty } from "@/routes/_protected.workspaces/$workspaceId/-mutations/properties";
import {
  entitiesKeys,
  useKanbanGroupOptions,
  visibleEntityFieldIds,
} from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import { propertiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";
import { taskKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/tasks";
import { getInternalPropertyId } from "@/routes/_protected.workspaces/$workspaceId/-utils";

type KanbanViewProps = {
  view: WorkspaceView;
  workspaceId: string;
};

type CreateFromKanbanOptions = {
  kind: EntityKind;
  taskStatus?: string | undefined;
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
  const queryClient = useQueryClient();
  const [hiddenGroups, setHiddenGroups] = useState(new Set());
  const [localColumnOrder, setLocalColumnOrder] = useState<string[]>([]);

  const handleCreate = async ({
    kind,
    taskStatus,
  }: CreateFromKanbanOptions) => {
    if (kind === "task") {
      const body = taskStatus
        ? {
            queryKey: entitiesKeys.all(workspaceId),
            name: t("tasks.untitled"),
            status: taskStatus,
          }
        : {
            queryKey: entitiesKeys.all(workspaceId),
            name: t("tasks.untitled"),
          };

      const response = await api
        .tasks({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .put(body);

      const entityId = response.data?.entityId;
      if (response.error || !entityId) {
        stellaToast.add({
          title: t("errors.actionFailed"),
          type: "error",
        });
        return;
      }

      stellaToast.add({
        title: t("success.taskCreated"),
        type: "success",
      });
      useInspectorStore
        .getState()
        .openTask({ taskId: entityId, workspaceId, isNew: true });
      return;
    }

    createEntities.mutate(
      {
        workspaceId,
        type: "manual-input",
        kind,
        name: t("workspaces.newDocument"),
      },
      {
        onSuccess: () => {
          stellaToast.add({
            title: t("success.documentCreated"),
            type: "success",
          });
        },
        onError: () => {
          stellaToast.add({
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
  // A `key` on the parent would remount the whole view and also wipe
  // `hiddenGroups` (which must survive a groupBy change), so this stays a
  // scoped reset. Adjust state during render (the React-sanctioned pattern)
  // instead of a lift-to-key.
  const [prevGroupBy, setPrevGroupBy] = useState(configuredGroupBy);
  if (prevGroupBy !== configuredGroupBy) {
    setPrevGroupBy(configuredGroupBy);
    setLocalColumnOrder([]);
  }

  const grouping = useMemo(
    () => resolveKanbanGrouping(configuredGroupBy, properties),
    [configuredGroupBy, properties],
  );
  const groupByPropertyId = getKanbanGroupingPropertyId(grouping);
  const isStatusGrouping = grouping.type === "status";
  const isBuiltInGrouping = grouping.type === "built-in";
  const groupByProperty =
    grouping.type === "property" ? grouping.property : null;
  // Verdict tiers are system-computed; card moves and uploads into a verdict
  // column must not overwrite the graded value.
  const isReadOnlyVerdictGrouping =
    groupByProperty?.tool.type === "playbook-verdict";

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
      id !== groupByPropertyId &&
      id !== getInternalPropertyId("kind") &&
      !hiddenProperties.includes(id),
  );

  const fieldIds = useMemo(
    () =>
      visibleEntityFieldIds({
        hiddenProperties,
        properties,
        requiredPropertyIds: groupByProperty ? [groupByProperty.id] : [],
      }),
    [groupByProperty, hiddenProperties, properties],
  );

  const { filters, sorts } = view.layout;

  // Mutation for changing task status via kanban drag-drop
  const updateTaskStatus = useMutation({
    mutationFn: async ({
      taskId,
      status,
    }: {
      taskId: string;
      status: string;
    }) => {
      const response = await api
        .tasks({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .patch({
          queryKey: entitiesKeys.all(workspaceId),
          taskId: toSafeId<"entity">(taskId),
          status,
        });
      if (response.error) {
        stellaToast.add({
          title: t("errors.actionFailed"),
          type: "error",
        });
      }
      return { taskId };
    },
    onSuccess: async ({ taskId }) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: entitiesKeys.all(workspaceId),
        }),
        queryClient.invalidateQueries({
          queryKey: taskKeys.detail(workspaceId, taskId),
        }),
      ]);
    },
  });

  // No group-by selected at all
  if (grouping.type === "none" || groupByPropertyId === null) {
    return (
      <EmptyState
        hint={t("workspaces.kanban.usePropertyHint")}
        icon={KanbanIcon}
        message={t("workspaces.kanban.selectPropertyHint")}
      />
    );
  }

  if (
    grouping.type === "built-in" &&
    groupByPropertyId !== getInternalPropertyId("kind")
  ) {
    return (
      <EmptyState
        hint={t("workspaces.kanban.usePropertyHint")}
        icon={KanbanIcon}
        message={t("workspaces.kanban.selectPropertyHint")}
      />
    );
  }

  // A Kanban card belongs to one column, and drop/upload write a single-select
  // value to the grouping property, so the property must be single-select. A
  // persisted multi-select grouping (from before the picker was mode-specific,
  // or after a property type change) would render columns no card can move into,
  // so fall back to the property prompt.
  if (
    grouping.type === "property" &&
    grouping.property.content.type !== "single-select"
  ) {
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
        TASK_STATUS_ORDER.map((s) => [s, t(`tasks.statusValues.${s}`)]),
      )
    : {};
  const entityKindLabels = {
    document: t("search.kinds.document"),
    folder: t("search.kinds.folder"),
    task: t("search.kinds.task"),
    message: t("search.kinds.message"),
    link: t("search.kinds.link"),
  };

  const options = resolveGroupOptions({
    grouping,
    groupByPropertyId,
    statusLabels,
    entityKindLabels,
  });

  const groups = getEntityGroups(options, t("common.uncategorized"));

  const handleDrop = (targetValue: string | null, entityId: string) => {
    if (isStatusGrouping && targetValue !== null) {
      updateTaskStatus.mutate({ taskId: entityId, status: targetValue });
      return;
    }
    if (isBuiltInGrouping || isReadOnlyVerdictGrouping) {
      stellaToast.add({
        title: t("workspaces.kanban.readOnlyGrouping"),
        type: "info",
      });
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
          void queryClient.invalidateQueries({
            queryKey: entitiesKeys.all(workspaceId),
          });
        },
      },
    );
  };

  const handleFileUpload = async (
    columnValue: string | null,
    files: File[],
  ) => {
    if (isReadOnlyVerdictGrouping) {
      stellaToast.add({
        title: t("workspaces.kanban.readOnlyGrouping"),
        type: "info",
      });
      return;
    }

    const filePropertyId = properties.find(
      (p) => p.content.type === "file",
    )?.id;

    if (!filePropertyId) {
      stellaToast.add({
        title: t("workspaces.files.addFilePropertyToUpload"),
        type: "warning",
      });
      return;
    }

    const results = await uploadFileEntitiesBatched({
      files,
      workspaceId,
      propertyId: filePropertyId,
      parentId: null,
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

  const handleChangeColor = (() => {
    if (groupByProperty) {
      return (optionValue: string, newColor: OptionColor) => {
        if (
          groupByProperty.content.type !== "single-select" &&
          groupByProperty.content.type !== "multi-select"
        ) {
          return;
        }
        // Verdict tiers are system-defined; their colors are not user-editable.
        if (groupByProperty.tool.type === "playbook-verdict") {
          return;
        }
        const updatedOptions = groupByProperty.content.options.map((opt) =>
          opt.value === optionValue
            ? {
                ...opt,
                color: newColor,
              }
            : opt,
        );
        updateProperty.mutate({
          workspaceId,
          propertyId: groupByPropertyId,
          name: groupByProperty.name,
          content: {
            ...groupByProperty.content,
            options: updatedOptions,
          },
          tool: groupByProperty.tool,
        });
      };
    }
    return null;
  })();

  const handleRenameColumn = (() => {
    if (groupByProperty) {
      return (oldValue: string, newValue: string) => {
        if (
          groupByProperty.content.type !== "single-select" &&
          groupByProperty.content.type !== "multi-select"
        ) {
          return;
        }
        // Verdict tiers are system-defined; their labels are not user-editable.
        if (groupByProperty.tool.type === "playbook-verdict") {
          return;
        }
        const updatedOptions = groupByProperty.content.options.map((opt) =>
          opt.value === oldValue
            ? {
                ...opt,
                value: newValue,
              }
            : opt,
        );
        updateProperty.mutate({
          workspaceId,
          propertyId: groupByPropertyId,
          name: groupByProperty.name,
          content: {
            ...groupByProperty.content,
            options: updatedOptions,
          },
          tool: groupByProperty.tool,
        });
      };
    }
    return null;
  })();

  const handleHideColumn = (value: string) => {
    setHiddenGroups((prev) => {
      const next = new Set(prev);
      next.add(value);
      return next;
    });
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
      // Verdict tiers are system-defined; their order is not user-editable.
      if (groupByProperty.tool.type === "playbook-verdict") {
        return;
      }
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
          <KanbanGroupColumn
            cardFields={cardFields}
            color={group.color}
            colorBg={group.colorBg}
            columnValue={value}
            fieldIds={fieldIds}
            filters={filters}
            groupByPropertyId={groupByPropertyId}
            key={value ?? "__uncategorized__"}
            onChangeColor={
              value !== null && handleChangeColor
                ? (c) => handleChangeColor(value, c)
                : undefined
            }
            onCreate={(kind) => {
              void handleCreate({
                kind,
                taskStatus:
                  isStatusGrouping && value !== null ? value : undefined,
              });
            }}
            onDrop={(entityId) => handleDrop(value, entityId)}
            onFileUpload={(files) => {
              void (async () => await handleFileUpload(value, files))();
            }}
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
            sorts={sorts}
            taskOnly={isStatusGrouping}
            title={group.label}
            workspaceId={workspaceId}
          />
        );
      })}
    </KanbanBoard>
  );
};

type KanbanGroupColumnProps = Omit<
  ComponentProps<typeof KanbanColumn>,
  "entities"
> & {
  workspaceId: string;
  filters: WorkspaceView["layout"]["filters"];
  sorts: WorkspaceView["layout"]["sorts"];
  fieldIds: string[];
  groupByPropertyId: string;
};

const KANBAN_GROUP_PAGE_SIZE = 200;

const KanbanGroupColumn = ({
  workspaceId,
  filters,
  sorts,
  fieldIds,
  groupByPropertyId,
  columnValue,
  ...props
}: KanbanGroupColumnProps) => {
  const query = useInfiniteQuery(
    useKanbanGroupOptions({
      workspaceId,
      filters,
      sorts,
      limit: KANBAN_GROUP_PAGE_SIZE,
      fieldMode: "visible",
      fieldIds,
      groupByPropertyId,
      groupValue: columnValue,
    }),
  );
  const entities = query.data?.pages.flatMap((page) => page.entities) ?? [];

  return (
    <KanbanColumn
      {...props}
      columnValue={columnValue}
      entities={entities}
      hasMore={query.hasNextPage}
      isLoadingMore={query.isFetchingNextPage}
      onLoadMore={() => {
        if (query.hasNextPage && !query.isFetchingNextPage) {
          void query.fetchNextPage();
        }
      }}
      workspaceId={workspaceId}
    />
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
  const handleColumnReorder = useEffectEvent(
    (sourceValue: string, targetValue: string, edge: Edge | null) => {
      onReorderColumn?.(sourceValue, targetValue, edge);
    },
  );

  useMountEffect(() => {
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
        canMonitor: ({ source }) => source.data["type"] === COLUMN_DRAG_TYPE,
        onDragStart: () => {
          lastPosition.current = null;
        },
        onDrag: ({ source, location }) => {
          const target = location.current.dropTargets.at(0);
          if (!target) {
            return;
          }
          const edge = extractClosestEdge(target.data);
          const targetValue = target.data["columnValue"];
          const sourceValue = source.data["columnValue"];
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
            handleColumnReorder(pos.sourceValue, pos.targetValue, pos.edge);
          }
        },
      }),
    );
  });

  return (
    <div className="flex h-full gap-4 overflow-x-auto p-4" ref={scrollRef}>
      {children}
    </div>
  );
};
