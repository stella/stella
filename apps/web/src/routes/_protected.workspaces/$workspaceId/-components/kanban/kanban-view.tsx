import { useEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps, ReactNode } from "react";

import { autoScrollForElements } from "@atlaskit/pragmatic-drag-and-drop-auto-scroll/element";
import { autoScrollForExternal } from "@atlaskit/pragmatic-drag-and-drop-auto-scroll/external";
import { extractClosestEdge } from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge";
import type { Edge } from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge";
import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import { monitorForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import type { OptionColor } from "@stll/api/types";
import { toastManager } from "@stll/ui/components/toast";
import {
  useMutation,
  useInfiniteQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { KanbanIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { toSafeId } from "@/lib/safe-id";
import type { EntityKind, WorkspaceProperty, WorkspaceView } from "@/lib/types";
// -- Auto-scrolling board container with forgiving column drop --
import { COLUMN_DRAG_TYPE } from "@/routes/_protected.workspaces/$workspaceId/-components/drag-constants";
import { EmptyState } from "@/routes/_protected.workspaces/$workspaceId/-components/empty-state";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import { KanbanColumn } from "@/routes/_protected.workspaces/$workspaceId/-components/kanban/kanban-column";
import {
  getKanbanGroupingPropertyId,
  resolveKanbanGrouping,
} from "@/routes/_protected.workspaces/$workspaceId/-components/kanban/kanban-view.logic";
import { resolveOptionColor } from "@/routes/_protected.workspaces/$workspaceId/-components/utils";
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
import { getInternalPropertyId } from "@/routes/_protected.workspaces/$workspaceId/-utils";

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
  const queryClient = useQueryClient();
  const [hiddenGroups, setHiddenGroups] = useState(new Set());
  const [localColumnOrder, setLocalColumnOrder] = useState<string[]>([]);

  const handleCreate = async (kind: EntityKind) => {
    if (kind === "task") {
      const response = await api
        .tasks({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .put({
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
        name: t("workspaces.newDocument"),
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

  const grouping = useMemo(
    () => resolveKanbanGrouping(configuredGroupBy, properties),
    [configuredGroupBy, properties],
  );
  const groupByPropertyId = getKanbanGroupingPropertyId(grouping);
  const isStatusGrouping = grouping.type === "status";
  const isBuiltInGrouping = grouping.type === "built-in";
  const groupByProperty =
    grouping.type === "property" ? grouping.property : null;

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
  const entityKindLabels = {
    document: t("search.kinds.document"),
    folder: t("search.kinds.folder"),
    task: t("search.kinds.task"),
    message: t("search.kinds.message"),
    link: t("search.kinds.link"),
  };

  const options: GroupOption[] = isStatusGrouping
    ? getStatusGroupOptions(statusLabels)
    : isBuiltInGrouping
      ? getBuiltInGroupOptions({
          labels: entityKindLabels,
          mode: groupByPropertyId,
        })
      : groupByProperty && isGroupableProperty(groupByProperty)
        ? getGroupOptions(groupByProperty)
        : [];

  const groups = getEntityGroups(options, t("common.uncategorized"));

  const handleDrop = (targetValue: string | null, entityId: string) => {
    if (isStatusGrouping && targetValue !== null) {
      updateTaskStatus.mutate({ taskId: entityId, status: targetValue });
      return;
    }
    if (isBuiltInGrouping) {
      toastManager.add({
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
      }
    : null;

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
              handleCreate(kind).catch(() => {
                // Error handled inside handleCreate
              });
            }}
            onDrop={(entityId) => handleDrop(value, entityId)}
            // eslint-disable-next-line typescript/no-misused-promises
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
  property.content.type === "single-select" ||
  property.content.type === "multi-select";

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
      color: resolveOptionColor(opt.color).color,
      colorBg: resolveOptionColor(opt.color).background,
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
};

const getEntityGroups = (
  options: GroupOption[],
  uncategorizedLabel: string,
): EntityGroup[] => {
  const result: EntityGroup[] = options.map((opt) => ({
    value: opt.value,
    label: opt.label,
    color: opt.color,
    colorBg: opt.colorBg,
    optionColor: opt.optionColor,
  }));
  result.push({ value: null, label: uncategorizedLabel });
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
  // eslint-disable-next-line no-inline-style-colors/no-inline-style-colors -- OptionColor domain constant, not a CSS color value
  open: "gray",
  // eslint-disable-next-line no-inline-style-colors/no-inline-style-colors -- OptionColor domain constant, not a CSS color value
  in_progress: "blue",
  in_review: "amber",
  // eslint-disable-next-line no-inline-style-colors/no-inline-style-colors -- OptionColor domain constant, not a CSS color value
  done: "green",
  // eslint-disable-next-line no-inline-style-colors/no-inline-style-colors -- OptionColor domain constant, not a CSS color value
  cancelled: "red",
};

/** Build GroupOption[] for task status kanban. */
const getStatusGroupOptions = (labels: Record<string, string>): GroupOption[] =>
  TASK_STATUS_ORDER.map((status) => {
    const optColor = STATUS_OPTION_COLORS[status] ?? "gray";
    return {
      value: status,
      label: labels[status] ?? status,
      color: resolveOptionColor(optColor).color,
      colorBg: resolveOptionColor(optColor).background,
      optionColor: optColor,
    };
  });

type EntityKindLabels = Record<
  "document" | "folder" | "task" | "message" | "link",
  string
>;

const getEntityKindGroupOptions = (labels: EntityKindLabels): GroupOption[] => [
  { value: "document", label: labels.document },
  { value: "folder", label: labels.folder },
  { value: "task", label: labels.task },
  { value: "message", label: labels.message },
  { value: "link", label: labels.link },
];

type BuiltInGroupOptionsParams = {
  labels: EntityKindLabels;
  mode: string;
};

/** Build GroupOption[] for read-only built-in groupings. */
const getBuiltInGroupOptions = ({
  labels,
  mode,
}: BuiltInGroupOptionsParams): GroupOption[] =>
  mode === getInternalPropertyId("kind")
    ? getEntityKindGroupOptions(labels)
    : [];
