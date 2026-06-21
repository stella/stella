import {
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  useInfiniteQuery,
  useQuery,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useTable } from "@tanstack/react-table";
import { ChevronDownIcon, ChevronRightIcon, TableIcon } from "lucide-react";
import { useFormatter, useTranslations } from "use-intl";

import { Skeleton } from "@stll/ui/components/skeleton";
import { cn } from "@stll/ui/lib/utils";

import type { TranslationKey } from "@/i18n/types";
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
import { GroupScopeProvider } from "@/routes/_protected.workspaces/$workspaceId/-components/table/group-scope";
import {
  DEFAULT_TABLE_COLUMN_MIN_SIZE,
  useTableColumns,
} from "@/routes/_protected.workspaces/$workspaceId/-components/table/table-columns";
import { workspaceTableFeatures } from "@/routes/_protected.workspaces/$workspaceId/-components/table/table-features";
import type {
  TableColumnDef,
  TableTreeNode,
} from "@/routes/_protected.workspaces/$workspaceId/-components/table/types";
import {
  WorkspaceGridCell,
  WorkspaceGridRow,
} from "@/routes/_protected.workspaces/$workspaceId/-components/table/workspace-grid";
import { getOrderedColumns } from "@/routes/_protected.workspaces/$workspaceId/-components/table/workspace-grid-order";
import { WorkspaceTable } from "@/routes/_protected.workspaces/$workspaceId/-components/table/workspace-table";
import {
  addPropertyColId,
  getWorkspaceGridTemplateColumns,
} from "@/routes/_protected.workspaces/$workspaceId/-components/table/workspace-table/internals";
import type { WorkspaceGridStyle } from "@/routes/_protected.workspaces/$workspaceId/-components/table/workspace-table/internals";
import { useSyncJustificationChunks } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-sync-justifications";
import { useSyncSelectedEntities } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-sync-selected-entities";
import { useTableState } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-table-state";
import {
  groupCountsOptions,
  useKanbanGroupOptions,
  visibleEntityFieldIds,
} from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import { propertiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";
import {
  getInternalPropertyId,
  toTableEntities,
} from "@/routes/_protected.workspaces/$workspaceId/-utils";

const GROUP_TABLE_PAGE_SIZE = 200;

// Static keys (not `tasks.statusValues.${status}`) so a missing or renamed key
// fails typecheck instead of silently rendering the raw key at runtime.
const STATUS_LABEL_KEYS = {
  open: "tasks.statusValues.open",
  in_progress: "tasks.statusValues.in_progress",
  in_review: "tasks.statusValues.in_review",
  done: "tasks.statusValues.done",
  cancelled: "tasks.statusValues.cancelled",
} as const satisfies Record<string, TranslationKey>;

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

  // One query for every group's count, so a group only fires its row query
  // when it actually has rows (empty groups never round-trip).
  const groupCounts = useQuery({
    ...groupCountsOptions({
      workspaceId,
      filters: view.layout.filters,
      groupByPropertyId: groupByPropertyId ?? "",
    }),
    enabled: groupByPropertyId !== null && !isUnsupportedBuiltIn,
  });
  const countByValue = useMemo(() => {
    const map = new Map<string | null, number>();
    for (const entry of groupCounts.data ?? []) {
      map.set(entry.value, entry.count);
    }
    return map;
  }, [groupCounts.data]);
  const countsLoaded = groupCounts.data !== undefined;

  // Each section loads its own rows; collect them by group so the row selection
  // resolves across every group the way the flat table does (the view toolbar
  // reads the resolved union from the store).
  const [treeDataByGroup, setTreeDataByGroup] = useState<
    Record<string, TableTreeNode[]>
  >({});
  const reportGroupTreeData = useCallback(
    (groupKey: string, nodes: TableTreeNode[]) => {
      setTreeDataByGroup((prev) =>
        prev[groupKey] === nodes ? prev : { ...prev, [groupKey]: nodes },
      );
    },
    [],
  );
  const allTreeData = useMemo(
    () => Object.values(treeDataByGroup).flat(),
    [treeDataByGroup],
  );
  useSyncSelectedEntities({ viewId: view.id, treeData: allTreeData });

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
            Object.keys(STATUS_LABEL_KEYS) as (keyof typeof STATUS_LABEL_KEYS)[]
          ).map((status) => [status, t(STATUS_LABEL_KEYS[status])]),
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
    // `w-max min-w-full` sizes the column to the widest group's table content
    // so every section — populated, empty, and the add-row — stretches to the
    // full table width (their bands then run the whole scroll width).
    <div className="flex w-max min-w-full flex-col" ref={scrollRef}>
      {groups.map((group) => (
        <GroupSection
          columns={columns}
          count={
            countsLoaded ? (countByValue.get(group.value) ?? 0) : undefined
          }
          fieldIds={fieldIds}
          group={group}
          groupByPropertyId={groupByPropertyId}
          key={group.value ?? "__uncategorized__"}
          outerScrollRef={scrollRef}
          reportGroupTreeData={reportGroupTreeData}
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

// Shared column geometry for the rows that live OUTSIDE a group's own table
// (the bottom add-row and the loading skeleton): a data-less table supplies the
// column sizes so they line up with the group tables above.
const useGroupGridGeometry = (
  columns: TableColumnDef[],
  tableState: ReturnType<typeof useTableState>,
) => {
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

  return { table, renderColumns, gridStyle };
};

type GroupedAddRowProps = {
  columns: TableColumnDef[];
  tableState: ReturnType<typeof useTableState>;
  workspaceId: string;
};

/**
 * One "+ new document" row for the whole grouped view, reusing the real
 * BottomRow. The wrapper carries the grid-template var and sticks the row to
 * the bottom of the scroll area.
 */
const GroupedAddRow = ({
  columns,
  tableState,
  workspaceId,
}: GroupedAddRowProps) => {
  const { table, gridStyle } = useGroupGridGeometry(columns, tableState);

  return (
    <div
      className="bg-background sticky start-0 bottom-0 z-30 order-last"
      style={gridStyle}
    >
      <BottomRow table={table} workspaceId={workspaceId} />
    </div>
  );
};

const SKELETON_ROW_KEYS = ["a", "b", "c", "d", "e"] as const;

type GroupSkeletonProps = {
  columns: TableColumnDef[];
  tableState: ReturnType<typeof useTableState>;
  rows: number;
};

// Placeholder rows in the real column grid, shown while a group's count (or its
// rows) are still loading — so the view never flashes "0 items".
const GroupSkeleton = ({ columns, tableState, rows }: GroupSkeletonProps) => {
  const { renderColumns, gridStyle } = useGroupGridGeometry(
    columns,
    tableState,
  );

  return (
    <div style={gridStyle}>
      {SKELETON_ROW_KEYS.slice(0, rows).map((rowKey) => (
        <WorkspaceGridRow className="pointer-events-none" key={rowKey}>
          {renderColumns.map((column) => (
            <WorkspaceGridCell
              className="flex min-h-12 items-center px-2"
              key={column.id}
              role="presentation"
            >
              <Skeleton className="h-3.5 w-3/5" />
            </WorkspaceGridCell>
          ))}
        </WorkspaceGridRow>
      ))}
    </div>
  );
};

type GroupSectionProps = {
  workspaceId: string;
  view: WorkspaceView<"table">;
  group: EntityGroup;
  groupByPropertyId: string;
  // Authoritative row count from the one upfront group-counts query;
  // `undefined` while that query is still loading.
  count: number | undefined;
  fieldIds: string[];
  columns: TableColumnDef[];
  sumProperties: WorkspaceProperty[];
  tableState: ReturnType<typeof useTableState>;
  outerScrollRef: RefObject<HTMLDivElement | null>;
  reportGroupTreeData: (groupKey: string, nodes: TableTreeNode[]) => void;
};

const GroupSection = ({
  workspaceId,
  view,
  group,
  groupByPropertyId,
  count,
  fieldIds,
  columns,
  sumProperties,
  tableState,
  outerScrollRef,
  reportGroupTreeData,
}: GroupSectionProps) => {
  const [collapsed, setCollapsed] = useState(false);

  // A category with no rows (an option no document carries yet) collapses to a
  // slim header; only groups known to have rows fire their row query.
  const isEmpty = count === 0;
  const hasRows = count !== undefined && count > 0;

  const query = useInfiniteQuery({
    ...useKanbanGroupOptions({
      workspaceId,
      filters: view.layout.filters,
      sorts: view.layout.sorts,
      limit: GROUP_TABLE_PAGE_SIZE,
      fieldMode: "visible",
      fieldIds,
      groupByPropertyId,
      groupValue: group.value,
    }),
    enabled: hasRows,
  });

  const entities = useMemo(
    () => query.data?.pages.flatMap((page) => page.entities) ?? [],
    [query.data],
  );
  const loadedCount = entities.length;

  const treeData = useMemo(() => toTableEntities(entities), [entities]);

  // Publish this section's rows to the parent so the row selection resolves
  // across every group; clear them when the section unmounts.
  const groupKey = group.value ?? "__uncategorized__";
  useEffect(() => {
    reportGroupTreeData(groupKey, treeData);
    return () => reportGroupTreeData(groupKey, NO_ROWS);
  }, [groupKey, treeData, reportGroupTreeData]);

  // AI cells read justifications from the workspace store; sync each loaded page
  // so the source hover card and citation highlights work in grouped views too.
  const justificationEntityIdChunks = useMemo(
    () =>
      query.data?.pages.map((page) =>
        page.entities.map((entity) => entity.entityId),
      ) ?? [],
    [query.data],
  );
  useSyncJustificationChunks({
    workspaceId,
    entityIdChunks: justificationEntityIdChunks,
  });

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

  // While the up-front counts load (count undefined) or a populated group's
  // rows are still fetching, show skeleton rows instead of an empty body.
  const isLoadingCounts = count === undefined;
  const isLoadingRows = hasRows && query.isLoading;
  const showSkeleton = isLoadingCounts || isLoadingRows;

  return (
    // Stretches to the container width (the full table width), so the
    // group-header band spans the whole scroll width even for empty groups.
    <section className={cn(isEmpty && "order-1")}>
      <GroupHeader
        collapsed={collapsed}
        empty={isEmpty}
        entities={entities}
        group={group}
        loadedCount={loadedCount}
        loading={isLoadingCounts}
        onToggle={() => setCollapsed((prev) => !prev)}
        sumProperties={sumProperties}
        totalCount={count ?? null}
      />
      {!collapsed && showSkeleton && (
        <GroupSkeleton
          columns={columns}
          rows={Math.min(count ?? 3, 5)}
          tableState={tableState}
        />
      )}
      {!collapsed &&
        hasRows &&
        !isLoadingRows && (
          // The table flows inline in the shared outer scroll (no nested scroll
          // box), so its rows render directly and the sticky group header stacks
          // cleanly above the columns. The group scope lets each column header's
          // "mark as reviewed" target just this subtable.
          <GroupScopeProvider
            value={{
              groupByPropertyId,
              groupValue: group.value,
              label: group.label,
            }}
          >
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
          </GroupScopeProvider>
        )}
    </section>
  );
};

type GroupHeaderProps = {
  group: EntityGroup;
  collapsed: boolean;
  empty: boolean;
  loading: boolean;
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
  loading,
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
          "flex min-w-0 flex-1 items-center py-1.5 text-start transition-colors duration-150",
          !empty && "hover:bg-foreground/[0.04]",
        )}
        disabled={empty}
        onClick={empty ? undefined : onToggle}
        type="button"
      >
        {/* The label stays pinned at the left while the band scrolls
            horizontally with the columns. */}
        <span className="bg-muted sticky start-0 flex items-center gap-2 ps-3">
          {empty ? (
            <span aria-hidden className="size-3.5 shrink-0" />
          ) : (
            <ChevronIcon className="text-muted-foreground size-3.5 shrink-0" />
          )}
          {group.optionColor && (
            <SelectColorIcon className="size-3.5" color={group.optionColor} />
          )}
          <span className="text-foreground text-sm font-medium">
            {group.label}
          </span>
          <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
            {loading ? (
              <Skeleton className="h-3 w-10" />
            ) : (
              t("workspaces.views.groupItemCount", { count })
            )}
          </span>
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
