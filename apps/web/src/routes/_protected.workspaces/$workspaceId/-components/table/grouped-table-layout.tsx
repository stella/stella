import { type RefObject, useMemo, useRef, useState } from "react";

import { useInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useTable } from "@tanstack/react-table";
import { ChevronDownIcon, ChevronRightIcon, TableIcon } from "lucide-react";
import { useFormatter, useTranslations } from "use-intl";

import { cn } from "@stll/ui/lib/utils";

import type {
  WorkspaceEntity,
  WorkspaceProperty,
  WorkspaceView,
} from "@/lib/types";
import { BottomRow } from "@/routes/_protected.workspaces/$workspaceId/-components/bottom-row";
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
import type {
  TableColumnDef,
  TableTreeNode,
} from "@/routes/_protected.workspaces/$workspaceId/-components/table/types";
import { getOrderedColumns } from "@/routes/_protected.workspaces/$workspaceId/-components/table/workspace-grid-order";
import { WorkspaceTable } from "@/routes/_protected.workspaces/$workspaceId/-components/table/workspace-table";
import {
  addPropertyColId,
  getWorkspaceGridTemplateColumns,
} from "@/routes/_protected.workspaces/$workspaceId/-components/table/workspace-table/internals";
import type { WorkspaceGridStyle } from "@/routes/_protected.workspaces/$workspaceId/-components/table/workspace-table/internals";
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
  // One shared scroller for the whole grouped view: every group's table flows
  // inside it (no nested scroll boxes), so the sticky group headers stack
  // correctly and a single horizontal scroll keeps every group aligned.
  const scrollRef = useRef<HTMLDivElement>(null);

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
    // `order` (set per-section once its count resolves). No own scroll: the
    // sections flow into the table layout's existing scroller, so the whole
    // grouped view shares one scroll (nested scroll boxes break the sticky
    // group headers and let a group's rows paint over the toolbar).
    <div className="flex flex-col" ref={scrollRef}>
      {groups.map((group) => (
        <GroupSection
          columns={columns}
          fieldIds={fieldIds}
          group={group}
          groupByPropertyId={groupByPropertyId}
          key={group.value ?? "__uncategorized__"}
          outerScrollRef={scrollRef}
          sumProperties={sumProperties}
          tableState={tableState}
          view={view}
          workspaceId={workspaceId}
        />
      ))}
      <GroupedAddRow
        columns={columns}
        tableState={tableState}
        workspaceId={workspaceId}
      />
    </div>
  );
};

const NO_ROWS: TableTreeNode[] = [];

type GroupedAddRowProps = {
  columns: TableColumnDef[];
  tableState: ReturnType<typeof useTableState>;
  workspaceId: string;
};

/**
 * One "+ new document" row for the whole grouped view, reusing the real
 * BottomRow. A data-less table supplies the shared column geometry so the row
 * lines up with the group tables above; the wrapper carries the grid-template
 * var and sticks the row to the bottom of the scroll area.
 */
const GroupedAddRow = ({
  columns,
  tableState,
  workspaceId,
}: GroupedAddRowProps) => {
  const table = useTable({
    features: workspaceTableFeatures,
    columnResizeMode: "onChange",
    data: NO_ROWS,
    columns,
    defaultColumn: { minSize: DEFAULT_TABLE_COLUMN_MIN_SIZE },
    manualSorting: true,
    enableSortingRemoval: false,
    enableSubRowSelection: true,
    getRowId: (row) => row.entityId,
    state: tableState.state,
  });

  const orderedColumns = getOrderedColumns({
    leftColumns: table.getLeftLeafColumns(),
    centerColumns: table.getCenterLeafColumns(),
    rightColumns: table.getRightLeafColumns(),
  }).filter((column) => column.getIsVisible());
  const renderColumns = orderedColumns.filter(
    (column) => column.id !== addPropertyColId,
  );
  const tableWidth = orderedColumns.reduce(
    (sum, column) => sum + column.getSize(),
    0,
  );
  const gridStyle: WorkspaceGridStyle = {
    "--workspace-table-columns": getWorkspaceGridTemplateColumns({
      renderColumns,
      addPropertyColumn: null,
    }),
    minWidth: tableWidth,
  };

  return (
    <div
      className="bg-background sticky start-0 bottom-0 z-30 order-last"
      style={gridStyle}
    >
      <BottomRow table={table} workspaceId={workspaceId} />
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
  outerScrollRef: RefObject<HTMLDivElement | null>;
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
  outerScrollRef,
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
    <section className={cn(isEmpty && "order-1")}>
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
          // The table flows inline in the shared outer scroll (no nested scroll
          // box), so its rows render directly and the sticky group header stacks
          // cleanly above the columns.
          <WorkspaceTable
            contentMode={tableState.contentMode}
            fillHeight={false}
            hasNextPage={query.hasNextPage}
            isFetchingNextPage={query.isFetchingNextPage}
            onLoadMore={() => {
              if (query.hasNextPage && !query.isFetchingNextPage) {
                void query.fetchNextPage();
              }
            }}
            outerScrollRef={outerScrollRef}
            showAddRow={false}
            stickyColumnHeader={false}
            table={table}
            workspaceId={workspaceId}
          />
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
        "bg-muted sticky top-0 z-40 flex items-center gap-2 border-b pe-3",
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
