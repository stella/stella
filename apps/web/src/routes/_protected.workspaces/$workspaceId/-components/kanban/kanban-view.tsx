import { useMemo, useRef, useState } from "react";
import type { ComponentProps, ReactNode } from "react";

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
import type { KanbanGroup } from "@stll/ui/kanban";
import {
  buildKanbanBoardMatrix,
  getKanbanGroupingPropertyId,
  getKanbanGroups,
  isKanbanGroupingRenderable,
  KANBAN_BOARD_AUTO_SCROLL_SOURCES,
  registerKanbanBoardAutoScroll,
  resolveKanbanGroupOptions,
} from "@stll/ui/kanban";
import { stellaToast } from "@stll/ui/toast";

import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import { getInternalPropertyId } from "@/components/workspaces/entity-utils";
import { useMountEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import { toSafeId } from "@/lib/safe-id";
import type { EntityKind, WorkspaceView } from "@/lib/types";
import {
  calculationKindsForProperty,
  isCalculableProperty,
} from "@/lib/workspaces/calculations";
// -- Auto-scrolling board container with forgiving column drop --
import { COLUMN_DRAG_TYPE } from "@/lib/workspaces/drag-constants";
import {
  useCreateEntities,
  useRenameEntity,
  useUpsertField,
} from "@/lib/workspaces/mutations/entities";
import { useUpdateProperty } from "@/lib/workspaces/mutations/properties";
import {
  isGradableProperty,
  isPlaybookVerdictProperty,
} from "@/lib/workspaces/playbook-verdicts";
import {
  entitiesWindowOptions,
  entitiesKeys,
  useKanbanGroupOptions,
  visibleEntityFieldIds,
} from "@/lib/workspaces/queries/entities";
import { propertiesOptions } from "@/lib/workspaces/queries/properties";
import { taskKeys } from "@/lib/workspaces/queries/tasks";
import { mergeLayout } from "@/lib/workspaces/view-layout";
import { EmptyState } from "@/routes/_protected.workspaces/$workspaceId/-components/empty-state";
import { KanbanColumn } from "@/routes/_protected.workspaces/$workspaceId/-components/kanban/kanban-column";
import type { KanbanCalculations } from "@/routes/_protected.workspaces/$workspaceId/-components/kanban/kanban-column";
import { KanbanSubgroupBoard } from "@/routes/_protected.workspaces/$workspaceId/-components/kanban/kanban-subgroup-board";
import {
  resolveWorkspaceKanbanGrouping,
  resolveWorkspaceKanbanGroupValue,
  resolveWorkspaceKanbanSubgroup,
} from "@/routes/_protected.workspaces/$workspaceId/-components/kanban/kanban-view.logic";
import { useWorkspaceKanbanSchema } from "@/routes/_protected.workspaces/$workspaceId/-components/kanban/use-kanban-schema";
import {
  uploadFileEntitiesBatched,
  useBatchUploadLabels,
} from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-create-file-entities";
import { useUpdateView } from "@/routes/_protected.workspaces/$workspaceId/-mutations/views";

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
  const updateView = useUpdateView(workspaceId);
  const queryClient = useQueryClient();
  const [hiddenGroups, setHiddenGroups] = useState(new Set());
  const [localColumnOrder, setLocalColumnOrder] = useState<string[]>([]);

  const handleCreate = async ({
    kind,
    taskStatus,
  }: CreateFromKanbanOptions): Promise<string | null> => {
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

      const { data: taskData, error: taskError } = await api
        .tasks({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .put(body);

      const entityId = taskData?.entityId;
      if (taskError || !entityId) {
        stellaToast.add({
          title: t("errors.actionFailed"),
          type: "error",
        });
        return null;
      }

      stellaToast.add({
        title: t("success.taskCreated"),
        type: "success",
      });
      useInspectorTabsStore
        .getState()
        .openTask({ taskId: entityId, workspaceId, isNew: true });
      return entityId;
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
    return null;
  };

  const { hiddenProperties } = view.layout;
  const configuredGroupBy =
    view.layout.type === "kanban" ? (view.layout.groupByPropertyId ?? "") : "";
  const configuredSubgroupBy =
    view.layout.type === "kanban"
      ? (view.layout.subgroupByPropertyId ?? "")
      : "";

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

  const schema = useWorkspaceKanbanSchema(properties);
  const grouping = useMemo(
    () => resolveWorkspaceKanbanGrouping(configuredGroupBy, schema),
    [configuredGroupBy, schema],
  );
  const groupByPropertyId = getKanbanGroupingPropertyId(grouping);
  const subgroup = useMemo(
    () =>
      resolveWorkspaceKanbanSubgroup(
        configuredSubgroupBy,
        groupByPropertyId,
        schema,
      ),
    [configuredSubgroupBy, groupByPropertyId, schema],
  );
  const subgroupByPropertyId = getKanbanGroupingPropertyId(subgroup);
  const isStatusGrouping =
    grouping.type === "built-in" &&
    grouping.group.id === getInternalPropertyId("status");
  const isBuiltInGrouping = grouping.type === "built-in";
  const groupByProperty =
    grouping.type === "property" ? grouping.property : null;
  const subgroupByProperty =
    subgroup.type === "property" ? subgroup.property : null;
  // Verdict tiers are system-computed; card moves and uploads into a verdict
  // column must not overwrite the graded value.
  const isReadOnlyVerdictGrouping =
    groupByProperty !== null && isPlaybookVerdictProperty(groupByProperty);

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
        requiredPropertyIds: [groupByProperty, subgroupByProperty]
          .filter((property) => property !== null)
          .map((property) => property.id),
      }),
    [groupByProperty, hiddenProperties, properties, subgroupByProperty],
  );

  const { filters, sorts } = view.layout;
  const hasRenderableSubgroup =
    isKanbanGroupingRenderable(subgroup) &&
    (subgroup.type !== "property" ||
      subgroup.property.content.type === "single-select");
  const subgroupQuery = useInfiniteQuery({
    ...entitiesWindowOptions({
      workspaceId,
      filters,
      sorts,
      limit: KANBAN_GROUP_PAGE_SIZE,
      fieldMode: "visible",
      fieldIds,
    }),
    enabled:
      hasRenderableSubgroup &&
      isKanbanGroupingRenderable(grouping) &&
      subgroupByPropertyId !== null,
  });
  const subgroupEntities = useMemo(
    () =>
      subgroupQuery.data
        ? subgroupQuery.data.pages.flatMap((page) => page.entities)
        : [],
    [subgroupQuery.data],
  );
  const subgroupMatrix = useMemo(() => {
    if (
      !hasRenderableSubgroup ||
      !isKanbanGroupingRenderable(grouping) ||
      subgroupByPropertyId === null
    ) {
      return null;
    }
    return buildKanbanBoardMatrix({
      group: grouping,
      subgroup,
      rows: subgroupEntities,
      uncategorizedLabel: t("common.uncategorized"),
      resolveGroupValue: ({ grouping: axis, row }) =>
        resolveWorkspaceKanbanGroupValue(axis, row),
    });
  }, [
    grouping,
    hasRenderableSubgroup,
    subgroup,
    subgroupByPropertyId,
    subgroupEntities,
    t,
  ]);

  const calculations: KanbanCalculations = {
    selections: view.layout.calculations,
    properties: properties
      .filter(
        (property) =>
          isCalculableProperty(property) &&
          !hiddenProperties.includes(property.id),
      )
      .map((property) => ({
        id: property.id,
        name: property.name,
        kinds: calculationKindsForProperty(property),
      })),
    onChange: (next) => {
      updateView.mutate({
        viewId: view.id,
        layout: mergeLayout(view.layout, { calculations: next }),
      });
    },
  };

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

  // A grouping with no columns is not a board: no group-by at all, or a
  // built-in grouping (created-by) that has no fixed column list to draw.
  if (!isKanbanGroupingRenderable(grouping) || groupByPropertyId === null) {
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

  const options = resolveKanbanGroupOptions(grouping);

  const groups = getKanbanGroups(options, t("common.uncategorized"));

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
          detached(
            queryClient.invalidateQueries({
              queryKey: entitiesKeys.all(workspaceId),
            }),
            "kanban-view.invalidate",
          );
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
        if (!isGradableProperty(groupByProperty)) {
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
        if (!isGradableProperty(groupByProperty)) {
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

  const canCreateTaskInLane = (laneValue: string | null) => {
    if (!isStatusGrouping) {
      return false;
    }
    if (subgroup.type === "property") {
      return true;
    }
    return (
      subgroup.type === "built-in" &&
      subgroup.group.id === getInternalPropertyId("kind") &&
      laneValue === "task"
    );
  };

  const handleCreateTaskInCell = async (
    status: string,
    laneValue: string | null,
  ) => {
    const entityId = await handleCreate({ kind: "task", taskStatus: status });
    if (!entityId || subgroup.type !== "property" || laneValue === null) {
      return;
    }

    await upsertField.mutateAsync({
      workspaceId,
      propertyId: subgroup.property.id,
      entityId,
      content: {
        version: 1,
        type: "single-select",
        value: laneValue,
      },
    });
    await queryClient.invalidateQueries({
      queryKey: entitiesKeys.all(workspaceId),
    });
  };

  if (subgroupMatrix !== null) {
    return (
      <KanbanSubgroupBoard
        canCreateTaskInLane={canCreateTaskInLane}
        cardFields={cardFields}
        hasMore={subgroupQuery.hasNextPage}
        isLoadingMore={subgroupQuery.isFetchingNextPage}
        matrix={subgroupMatrix}
        onCreateTask={(status, laneValue) => {
          detached(
            handleCreateTaskInCell(status, laneValue),
            "kanban-view.create-task-in-cell",
          );
        }}
        onLoadMore={() => {
          if (subgroupQuery.hasNextPage && !subgroupQuery.isFetchingNextPage) {
            detached(
              subgroupQuery.fetchNextPage(),
              "kanban-view.fetch-subgroups-next-page",
            );
          }
        }}
        onRenameEntity={handleRenameEntity}
        properties={properties}
        workspaceId={workspaceId}
      />
    );
  }

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
      if (!isGradableProperty(groupByProperty)) {
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
          .filter((g): g is KanbanGroup => g !== undefined)
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
            calculations={calculations}
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
              detached(
                handleCreate({
                  kind,
                  taskStatus:
                    isStatusGrouping && value !== null ? value : undefined,
                }),
                "kanban-view.create",
              );
            }}
            onDrop={(entityId) => handleDrop(value, entityId)}
            onFileUpload={(files) => {
              detached(
                (async () => await handleFileUpload(value, files))(),
                "kanban-view.file-upload",
              );
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
  const entities = query.data
    ? query.data.pages.flatMap((page) => page.entities)
    : [];

  return (
    <KanbanColumn
      {...props}
      columnValue={columnValue}
      entities={entities}
      hasMore={query.hasNextPage}
      isLoadingMore={query.isFetchingNextPage}
      onLoadMore={() => {
        if (query.hasNextPage && !query.isFetchingNextPage) {
          detached(query.fetchNextPage(), "kanban-view.fetch-next-page");
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
  const handleColumnReorder = useLatestCallback(
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
      registerKanbanBoardAutoScroll({
        element: el,
        sources: KANBAN_BOARD_AUTO_SCROLL_SOURCES.elementsAndExternal,
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
