import { useMemo, useState } from "react";

import { useInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useTable } from "@tanstack/react-table";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  PlusIcon,
  TableIcon,
} from "lucide-react";
import { useFormatter, useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { cn } from "@stll/ui/lib/utils";

import type {
  WorkspaceEntity,
  WorkspaceProperty,
  WorkspaceView,
} from "@/lib/types";
import { AddEntityMenu } from "@/routes/_protected.workspaces/$workspaceId/-components/add-entity-menu";
import { EmptyState } from "@/routes/_protected.workspaces/$workspaceId/-components/empty-state";
import {
  getEntityGroups,
  getKanbanGroupingPropertyId,
  resolveGroupOptions,
  resolveKanbanGrouping,
} from "@/routes/_protected.workspaces/$workspaceId/-components/kanban/kanban-view.logic";
import type { EntityGroup } from "@/routes/_protected.workspaces/$workspaceId/-components/kanban/kanban-view.logic";
import { SelectColorIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/properties/shared";
import {
  DEFAULT_TABLE_COLUMN_MIN_SIZE,
  useTableColumns,
} from "@/routes/_protected.workspaces/$workspaceId/-components/table/table-columns";
import { workspaceTableFeatures } from "@/routes/_protected.workspaces/$workspaceId/-components/table/table-features";
import type { TableColumnDef } from "@/routes/_protected.workspaces/$workspaceId/-components/table/types";
import { WorkspaceTable } from "@/routes/_protected.workspaces/$workspaceId/-components/table/workspace-table";
import { useTableState } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-table-state";
import {
  useKanbanGroupOptions,
  visibleEntityFieldIds,
} from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import { propertiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";
import {
  getInternalPropertyId,
  toTableEntities,
} from "@/routes/_protected.workspaces/$workspaceId/-utils";

const GROUP_TABLE_PAGE_SIZE = 200;

type GroupedTableLayoutProps = {
  workspaceId: string;
  view: WorkspaceView<"table">;
};

export const GroupedTableLayout = ({
  workspaceId,
  view,
}: GroupedTableLayoutProps) => {
  const t = useTranslations();
  const { data: properties } = useSuspenseQuery(propertiesOptions(workspaceId));
  const tableState = useTableState({ workspaceId, view });
  const columns = useTableColumns({ properties, view });

  const groupByConfig = view.layout.groupByPropertyId ?? "";
  const grouping = useMemo(
    () => resolveKanbanGrouping(groupByConfig, properties),
    [groupByConfig, properties],
  );
  const groupByPropertyId = getKanbanGroupingPropertyId(grouping);

  const groupByProperty =
    grouping.type === "property" ? grouping.property : null;
  const fieldIds = useMemo(
    () =>
      visibleEntityFieldIds({
        hiddenProperties: view.layout.hiddenProperties,
        properties,
        requiredPropertyIds: groupByProperty ? [groupByProperty.id] : [],
      }),
    [groupByProperty, view.layout.hiddenProperties, properties],
  );

  // The int columns that should roll up a per-group sum: visible int
  // properties (the grouping property itself never rolls up).
  const sumProperties = useMemo(
    () =>
      properties.filter(
        (property) =>
          property.content.type === "int" &&
          property.id !== groupByPropertyId &&
          !view.layout.hiddenProperties.includes(property.id),
      ),
    [properties, groupByPropertyId, view.layout.hiddenProperties],
  );

  // Created-by and other built-ins beyond "kind" have no server-side
  // grouping condition, so they fall back to a flat selection prompt
  // (matches the kanban view's behaviour for unsupported groupings).
  const isUnsupportedBuiltIn =
    grouping.type === "built-in" &&
    groupByPropertyId !== getInternalPropertyId("kind");

  if (groupByPropertyId === null || isUnsupportedBuiltIn) {
    return (
      <EmptyState
        icon={TableIcon}
        message={t("workspaces.views.selectProperty")}
        workspaceId={workspaceId}
      />
    );
  }

  const statusLabels =
    grouping.type === "status"
      ? Object.fromEntries(
          (
            ["open", "in_progress", "in_review", "done", "cancelled"] as const
          ).map((status) => [status, t(`tasks.statusValues.${status}`)]),
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

  return (
    // Flex column so empty categories can sink below populated ones via
    // `order` (set per-section once its count resolves) without lifting
    // each group's async count into the parent.
    <div className="flex h-full flex-col overflow-y-auto">
      {groups.map((group) => (
        <GroupSection
          columns={columns}
          fieldIds={fieldIds}
          group={group}
          groupByPropertyId={groupByPropertyId}
          key={group.value ?? "__uncategorized__"}
          sumProperties={sumProperties}
          tableState={tableState}
          view={view}
          workspaceId={workspaceId}
        />
      ))}
      {/* One add-row for the whole grouped view (order-last keeps it below
          even the sunk empty categories), instead of one per subtable. */}
      <AddEntityMenu
        render={
          <Button
            className="bg-background text-muted-foreground hover:text-foreground sticky bottom-0 z-20 order-last h-10 w-full justify-start gap-2 rounded-none border-t px-3 font-normal transition-colors duration-150"
            variant="ghost"
          >
            <PlusIcon className="size-3.5" />
            {t("workspaces.newDocument")}
          </Button>
        }
        uploadOnly
        workspaceId={workspaceId}
      />
    </div>
  );
};

type GroupSectionProps = {
  workspaceId: string;
  view: WorkspaceView<"table">;
  group: EntityGroup;
  groupByPropertyId: string;
  fieldIds: string[];
  columns: TableColumnDef[];
  sumProperties: WorkspaceProperty[];
  tableState: ReturnType<typeof useTableState>;
};

const GroupSection = ({
  workspaceId,
  view,
  group,
  groupByPropertyId,
  fieldIds,
  columns,
  sumProperties,
  tableState,
}: GroupSectionProps) => {
  const [collapsed, setCollapsed] = useState(false);

  const query = useInfiniteQuery(
    useKanbanGroupOptions({
      workspaceId,
      filters: view.layout.filters,
      sorts: view.layout.sorts,
      limit: GROUP_TABLE_PAGE_SIZE,
      fieldMode: "visible",
      fieldIds,
      groupByPropertyId,
      groupValue: group.value,
      includeTotalCount: true,
    }),
  );

  const entities = useMemo(
    () => query.data?.pages.flatMap((page) => page.entities) ?? [],
    [query.data],
  );
  const totalCount = query.data?.pages.at(0)?.totalCount ?? null;
  const loadedCount = entities.length;

  // A category with no rows (an option no document carries yet) collapses
  // to a slim header instead of an empty table body. `isLoading` guards the
  // first fetch so a not-yet-resolved group never flashes as empty.
  const isEmpty = !query.isLoading && (totalCount ?? loadedCount) === 0;

  const treeData = useMemo(() => toTableEntities(entities), [entities]);

  const table = useTable({
    features: workspaceTableFeatures,
    columnResizeMode: "onChange",
    data: treeData,
    columns,
    defaultColumn: {
      minSize: DEFAULT_TABLE_COLUMN_MIN_SIZE,
    },
    manualSorting: true,
    enableSortingRemoval: false,
    enableSubRowSelection: true,
    getRowId: (row) => row.entityId,
    state: tableState.state,
    ...tableState.listeners,
  });

  return (
    <section className={cn("min-w-0", isEmpty && "order-1")}>
      <GroupHeader
        collapsed={collapsed}
        empty={isEmpty}
        entities={entities}
        group={group}
        loadedCount={loadedCount}
        onToggle={() => setCollapsed((prev) => !prev)}
        sumProperties={sumProperties}
        totalCount={totalCount}
      />
      {!collapsed &&
        !isEmpty && (
          // Each section's table owns an internal scroll container (the
          // virtualizer needs a sized scroll element), so the section is
          // bounded; the outer page scrolls between sections. This mirrors
          // kanban columns, which each scroll independently.
          <div className="flex max-h-[70vh] min-h-32 flex-col">
            <WorkspaceTable
              contentMode={tableState.contentMode}
              hasNextPage={query.hasNextPage}
              isFetchingNextPage={query.isFetchingNextPage}
              onLoadMore={() => {
                if (query.hasNextPage && !query.isFetchingNextPage) {
                  void query.fetchNextPage();
                }
              }}
              showAddRow={false}
              table={table}
              workspaceId={workspaceId}
            />
          </div>
        )}
    </section>
  );
};

type GroupHeaderProps = {
  group: EntityGroup;
  collapsed: boolean;
  empty: boolean;
  onToggle: () => void;
  loadedCount: number;
  totalCount: number | null;
  entities: WorkspaceEntity[];
  sumProperties: WorkspaceProperty[];
};

const GroupHeader = ({
  group,
  collapsed,
  empty,
  onToggle,
  loadedCount,
  totalCount,
  entities,
  sumProperties,
}: GroupHeaderProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const count = totalCount ?? loadedCount;
  const ChevronIcon = collapsed ? ChevronRightIcon : ChevronDownIcon;

  return (
    <div
      className={cn(
        "bg-muted/40 sticky top-0 z-20 flex items-center gap-2 border-b pe-3",
        // An empty category recedes into the background, surfacing on hover
        // so it stays scannable without competing with populated groups.
        empty && "opacity-60 transition-opacity duration-200 hover:opacity-100",
      )}
    >
      {/* The whole header row is the toggle target, not just the chevron. */}
      <button
        aria-expanded={empty ? undefined : !collapsed}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2 py-1.5 ps-3 text-start transition-colors duration-150",
          !empty && "hover:bg-foreground/[0.04]",
        )}
        disabled={empty}
        onClick={empty ? undefined : onToggle}
        type="button"
      >
        {empty ? (
          <span aria-hidden className="size-3.5 shrink-0" />
        ) : (
          <ChevronIcon className="text-muted-foreground size-3.5 shrink-0" />
        )}
        {group.optionColor && (
          <SelectColorIcon className="size-3.5" color={group.optionColor} />
        )}
        <span className="text-foreground truncate text-sm font-medium">
          {group.label}
        </span>
        <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
          {t("workspaces.views.groupItemCount", { count })}
        </span>
      </button>
      {!empty &&
        sumProperties.map((property) => {
          const sum = sumIntProperty(entities, property.id);
          return (
            <span
              className="text-muted-foreground ms-1 text-xs tabular-nums"
              key={property.id}
            >
              <span className="font-medium">{property.name}</span>
              {": "}
              {format.number(sum)}
            </span>
          );
        })}
    </div>
  );
};

const sumIntProperty = (
  entities: readonly WorkspaceEntity[],
  propertyId: string,
): number => {
  let total = 0;
  for (const entity of entities) {
    const content = entity.fields[propertyId]?.content;
    if (content?.type === "int") {
      total += content.value;
    }
  }
  return total;
};
