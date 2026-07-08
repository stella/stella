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

import { useExternalSyncEffect } from "@/hooks/use-effect";
import type {
  EntityKind,
  PropertyId,
  WorkspaceEntity,
  WorkspaceProperty,
  WorkspaceView,
} from "@/lib/types";
import { BottomRow } from "@/routes/_protected.workspaces/$workspaceId/-components/bottom-row";
import { EmptyState } from "@/routes/_protected.workspaces/$workspaceId/-components/empty-state";
import {
  getEntityGroups,
  getKanbanGroupingPropertyId,
  isGroupableProperty,
  resolveGroupOptions,
  resolveKanbanGrouping,
} from "@/routes/_protected.workspaces/$workspaceId/-components/kanban/kanban-view.logic";
import type { EntityGroup } from "@/routes/_protected.workspaces/$workspaceId/-components/kanban/kanban-view.logic";
import { SelectColorIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/properties/shared";
import {
  buildDocTypeGateLabels,
  resolveDocumentTypeClassifier,
  selectGroupColumns,
} from "@/routes/_protected.workspaces/$workspaceId/-components/table/group-columns";
import { GroupScopeProvider } from "@/routes/_protected.workspaces/$workspaceId/-components/table/group-scope";
import { MobileTableOrientationGate } from "@/routes/_protected.workspaces/$workspaceId/-components/table/mobile-table-orientation-gate";
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
  getScrollableAncestor,
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

// Grouped views eager-load only the first few sections' rows upfront; every
// later section rides its IntersectionObserver scroll-gate (400px lookahead)
// so it loads as it nears the viewport. This caps the initial burst of
// per-section /kanban-group fetches instead of firing one per group at once.
const GROUP_EAGER_LOAD_COUNT = 3;

// A grouped document table never lists folders or tasks as rows, matching the
// flat window query; passed to the kanban-group endpoint so its rows (and the
// group-counts) stay in sync.
const GROUPED_TABLE_EXCLUDED_KINDS: EntityKind[] = ["folder", "task"];

// Stable key for a group. The null (uncategorized) bucket and real string values
// live in disjoint namespaces so an option literally named "uncategorized"
// can't collide with the null bucket.
const groupKeyFor = (value: string | null): string =>
  value === null ? "uncategorized" : `value:${value}`;

const getEagerGroupValues = (
  groups: EntityGroup[],
  countByValue: Map<string | null, number>,
) => {
  const values = new Set<string | null>();
  for (const group of groups) {
    if ((countByValue.get(group.value) ?? 0) === 0) {
      continue;
    }
    values.add(group.value);
    if (values.size === GROUP_EAGER_LOAD_COUNT) {
      break;
    }
  }
  return values;
};

// Stable empty gate map for groupings other than the "Document Type" classifier,
// where every section shares the full column set (no per-section filtering).
const EMPTY_DOC_TYPE_GATE = new Map<string, Set<string>>();

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
  // The grouping property's option values, sent to the row/count queries so the
  // uncategorized group folds in cells whose value is no longer an option
  // (`undefined` for the built-in "kind" grouping, which has no option list).
  const optionValues = useMemo(
    () =>
      groupByProperty?.content.type === "single-select" ||
      groupByProperty?.content.type === "multi-select"
        ? groupByProperty.content.options.map((option) => option.value)
        : undefined,
    [groupByProperty],
  );
  const fieldIds = useMemo(
    () =>
      visibleEntityFieldIds({
        hiddenProperties: view.layout.hiddenProperties,
        properties,
        requiredPropertyIds: groupByProperty ? [groupByProperty.id] : [],
      }),
    [groupByProperty, view.layout.hiddenProperties, properties],
  );

  // Auto-summing every int column per group is misleading for non-additive
  // columns (e.g. "Splatnost faktur (dny)" — you don't add up days), so the
  // per-group rollups are disabled until aggregation becomes opt-in per column.
  const sumProperties = useMemo<WorkspaceProperty[]>(() => [], []);

  // When grouped by the workspace's "Document Type" classifier, each section
  // renders the common columns plus only the playbook columns scoped to that
  // section's document type, read from each column's materialized doc-type gate.
  // Any other grouping keeps the shared column set.
  const documentTypeClassifier = useMemo(
    () => resolveDocumentTypeClassifier(properties),
    [properties],
  );
  const classifierPropertyId =
    groupByPropertyId !== null &&
    documentTypeClassifier?.id === groupByPropertyId
      ? groupByPropertyId
      : null;
  const gateLabelsByColumnId = useMemo(
    () =>
      classifierPropertyId !== null
        ? buildDocTypeGateLabels({
            properties,
            classifierPropertyId,
          })
        : EMPTY_DOC_TYPE_GATE,
    [classifierPropertyId, properties],
  );
  // The whole-view "+ new document" row carries the common (ungated) columns: a
  // freshly created, unclassified document has no document type, so no playbook
  // column applies to it yet.
  const addRowColumns = useMemo(
    () =>
      selectGroupColumns({ columns, gateLabelsByColumnId, groupValue: null }),
    [columns, gateLabelsByColumnId],
  );

  // Only "kind" and single/multi-select property groupings are supported for a
  // document table. Status grouping is task-only, so on a document table (which
  // excludes tasks) group-counts would report task buckets while the row fetch
  // returns nothing. Created-by and other built-ins have no server-side grouping
  // condition. A property whose type changed away from select (the layout keeps
  // the id) would bucket every distinct scalar into an unbounded set of groups.
  // All fall back to a flat selection prompt, matching the kanban view.
  const isUnsupportedGrouping =
    grouping.type === "status" ||
    (grouping.type === "built-in" &&
      groupByPropertyId !== getInternalPropertyId("kind")) ||
    (grouping.type === "property" && !isGroupableProperty(grouping.property));

  // One query for every group's count, so a group only fires its row query
  // when it actually has rows (empty groups never round-trip).
  const groupCounts = useQuery({
    ...groupCountsOptions({
      workspaceId,
      filters: view.layout.filters,
      groupByPropertyId: groupByPropertyId ?? "",
      ...(optionValues !== undefined && { optionValues }),
    }),
    enabled: groupByPropertyId !== null && !isUnsupportedGrouping,
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
  const allTreeData = useMemo(() => {
    // A multi-select grouping puts the same entity in several sections, so
    // dedupe by entity id before resolving the shared selection and row-id set.
    const seen = new Set<string>();
    const unique: TableTreeNode[] = [];
    for (const node of Object.values(treeDataByGroup).flat()) {
      if (!seen.has(node.entityId)) {
        seen.add(node.entityId);
        unique.push(node);
      }
    }
    return unique;
  }, [treeDataByGroup]);
  useSyncSelectedEntities({ viewId: view.id, treeData: allTreeData });
  // Every row id across all sections, so a section's select-all keeps the other
  // sections' selections (they share one selection) without resurrecting stale
  // ids.
  const allRowIds = useMemo(
    () => allTreeData.map((node) => node.entityId),
    [allTreeData],
  );
  // The cross-group row-id union grows as each group's first page lands, so
  // passing it as a prop re-renders every section on every group load (each
  // rebuilding its table). Sections only read it inside the "select all"
  // handler, never during render, so mirror it into a ref: the prop stays
  // referentially stable and the per-load re-render fan-out disappears.
  const allRowIdsRef = useRef(allRowIds);
  // eslint-disable-next-line no-raw-use-effect/no-raw-use-effect -- mirroring a render value into a ref for event-time reads; not external-system sync nor mount-only, so neither wrapper applies
  useEffect(() => {
    allRowIdsRef.current = allRowIds;
  }, [allRowIds]);

  if (groupByPropertyId === null || isUnsupportedGrouping) {
    return (
      <EmptyState
        icon={TableIcon}
        message={t("workspaces.views.selectProperty")}
        workspaceId={workspaceId}
      />
    );
  }

  // Status grouping is rejected above (isUnsupportedGrouping), so a document
  // table never needs status labels.
  const statusLabels = {};
  const entityKindLabels = {
    document: t("common.document"),
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
  // Cells whose value is no longer a current option fold into the uncategorized
  // group server-side (the row/count queries treat "no current-option value" as
  // uncategorized), so the sections are just the option groups plus uncategorized.
  const groups = getEntityGroups(options, t("common.uncategorized"));
  const eagerGroupValues = countsLoaded
    ? getEagerGroupValues(groups, countByValue)
    : null;

  return (
    // Flex column so empty categories can sink below populated ones via
    // `order` (set per-section once its count resolves). No own scroll: the
    // sections flow into the table layout's existing scroller, so the whole
    // grouped view shares one scroll (nested scroll boxes break the sticky
    // group headers and let a group's rows paint over the toolbar).
    // `w-max min-w-full` sizes the column to the widest group's table content
    // so every section — populated, empty, and the add-row — stretches to the
    // full table width (their bands then run the whole scroll width).
    <MobileTableOrientationGate>
      <div className="flex w-max min-w-full flex-col" ref={scrollRef}>
        {groups.map((group) => (
          <GroupSection
            columns={columns}
            count={
              countsLoaded ? (countByValue.get(group.value) ?? 0) : undefined
            }
            eager={eagerGroupValues?.has(group.value) ?? false}
            fieldIds={fieldIds}
            gateLabelsByColumnId={gateLabelsByColumnId}
            group={group}
            groupByPropertyId={groupByPropertyId}
            key={groupKeyFor(group.value)}
            optionValues={optionValues}
            outerScrollRef={scrollRef}
            reportGroupTreeData={reportGroupTreeData}
            selectAllPreservableRowIdsRef={allRowIdsRef}
            sumProperties={sumProperties}
            tableState={tableState}
            view={view}
            workspaceId={workspaceId}
          />
        ))}
        <GroupedAddRow
          columns={addRowColumns}
          tableState={tableState}
          workspaceId={workspaceId}
        />
      </div>
    </MobileTableOrientationGate>
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
      className="bg-background sticky start-0 bottom-0 z-50 order-last"
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
  optionValues: string[] | undefined;
  // Authoritative row count from the one upfront group-counts query;
  // `undefined` while that query is still loading.
  count: number | undefined;
  // Skip the lazy scroll-gate and load this section's rows upfront.
  eager: boolean;
  fieldIds: string[];
  columns: TableColumnDef[];
  // propertyId -> document-type labels its column is gated to, for per-section
  // column selection when grouped by the "Document Type" classifier. Empty for
  // other groupings (every section then renders the full column set).
  gateLabelsByColumnId: Map<string, Set<string>>;
  sumProperties: WorkspaceProperty[];
  tableState: ReturnType<typeof useTableState>;
  outerScrollRef: RefObject<HTMLDivElement | null>;
  reportGroupTreeData: (groupKey: string, nodes: TableTreeNode[]) => void;
  selectAllPreservableRowIdsRef: RefObject<string[]>;
};

const GroupSection = ({
  workspaceId,
  view,
  group,
  groupByPropertyId,
  optionValues,
  count,
  eager,
  fieldIds,
  columns,
  gateLabelsByColumnId,
  sumProperties,
  tableState,
  outerScrollRef,
  reportGroupTreeData,
  selectAllPreservableRowIdsRef,
}: GroupSectionProps) => {
  const [collapsed, setCollapsed] = useState(false);

  // This section's columns: common columns plus the playbook columns scoped to
  // this group's document type (see selectGroupColumns). Sections legitimately
  // differ in columns and grid width when grouped by the "Document Type"
  // classifier; for other groupings this returns the shared columns unchanged.
  const sectionColumns = useMemo(
    () =>
      selectGroupColumns({
        columns,
        gateLabelsByColumnId,
        groupValue: group.value,
      }),
    [columns, gateLabelsByColumnId, group.value],
  );

  // A category with no rows (an option no document carries yet) collapses to a
  // slim header; only groups known to have rows fire their row query.
  const isEmpty = count === 0;
  const hasRows = count !== undefined && count > 0;

  // Defer a populated group's row query until it scrolls near the viewport, so a
  // property with many populated groups doesn't fan out one /kanban-group request
  // (and up to GROUP_TABLE_PAGE_SIZE rows) per group on first render. Once seen,
  // it stays loaded.
  const sectionRef = useRef<HTMLElement>(null);
  const [hasScrolledIntoView, setHasScrolledIntoView] = useState(false);
  useExternalSyncEffect(() => {
    const section = sectionRef.current;
    if (eager || hasScrolledIntoView || !hasRows || !section) {
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setHasScrolledIntoView(true);
        }
      },
      { root: getScrollableAncestor(section), rootMargin: "400px" },
    );
    observer.observe(section);
    return () => observer.disconnect();
  }, [eager, hasScrolledIntoView, hasRows]);

  const query = useInfiniteQuery({
    ...useKanbanGroupOptions({
      workspaceId,
      filters: view.layout.filters,
      sorts: view.layout.sorts,
      limit: GROUP_TABLE_PAGE_SIZE,
      fieldMode: "visible",
      fieldIds,
      excludedKinds: GROUPED_TABLE_EXCLUDED_KINDS,
      groupByPropertyId,
      groupValue: group.value,
      ...(optionValues !== undefined && { optionValues }),
    }),
    enabled: hasRows && (eager || hasScrolledIntoView),
  });

  // When a group empties (its last row moved/deleted), the count is 0 and the
  // query is disabled, but React Query can still hold cached pages for this key.
  // Drop them when the group has no rows so stale rows aren't published to the
  // selection union or rendered.
  const entities = useMemo(
    () =>
      hasRows ? (query.data?.pages.flatMap((page) => page.entities) ?? []) : [],
    [hasRows, query.data],
  );
  const loadedCount = entities.length;

  const treeData = useMemo(() => toTableEntities(entities), [entities]);

  // Publish this section's rows to the parent so the row selection resolves
  // across every group; clear them when the section unmounts.
  const groupKey = groupKeyFor(group.value);
  useExternalSyncEffect(() => {
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
    columns: sectionColumns,
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

  // While the up-front counts load, or a populated group is still offscreen /
  // fetching its first page, show skeleton rows instead of an empty body.
  const isLoadingCounts = count === undefined;
  const isLoadingRows =
    hasRows && (eager || hasScrolledIntoView) && query.isLoading;
  // Eager sections load upfront, so they're never "pending until scrolled in".
  const isPendingVisible = hasRows && !eager && !hasScrolledIntoView;
  const showSkeleton = isLoadingCounts || isLoadingRows || isPendingVisible;

  return (
    // Stretches to the container width (the full table width), so the
    // group-header band spans the whole scroll width even for empty groups.
    <section className={cn(isEmpty && "order-1")} ref={sectionRef}>
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
          columns={sectionColumns}
          rows={Math.min(count ?? 3, 5)}
          tableState={tableState}
        />
      )}
      {!collapsed &&
        hasRows &&
        (eager || hasScrolledIntoView) &&
        !isLoadingRows && (
          // The table flows inline in the shared outer scroll (no nested scroll
          // box), so its rows render directly and the sticky group header stacks
          // cleanly above the columns. The group scope lets each column header's
          // "mark as reviewed" target just this subtable.
          <GroupScopeProvider
            value={{
              groupByPropertyId,
              groupValue: group.value,
              optionValues,
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
              selectAllPreservableRowIdsRef={selectAllPreservableRowIdsRef}
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
  // The per-group rollups sum only the rows loaded so far, while the count comes
  // from the server and is always exact. Show the sums only once every row in
  // the group is loaded, so a partially-scrolled large group never displays a
  // misleading subtotal next to a complete count.
  const sumsComplete = totalCount !== null && loadedCount >= totalCount;

  return (
    <div
      className={cn(
        "sticky top-0 z-40 flex items-center gap-2 border-b pe-3",
        // An empty category recedes into the background, surfacing on hover
        // so it stays scannable without competing with populated groups.
        empty && "opacity-60 transition-opacity duration-200 hover:opacity-100",
      )}
      // Opaque header so scrolled rows don't show through. `bg-muted` and
      // `bg-secondary` are both translucent (~4% over transparent) in this theme,
      // so we composite that 4% tint over the opaque background by hand.
      style={{
        backgroundColor:
          "color-mix(in oklab, var(--foreground) 4%, var(--background))",
      }}
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
            horizontally with the columns. The full-width `bg-muted` band lives
            on the row wrapper, so the pinned label adds no second layer (a
            second translucent `bg-muted` here darkened only the label's span,
            reading as a partial band that stopped mid-row). */}
        <span className="sticky start-0 flex items-center gap-2 ps-3">
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
        sumsComplete &&
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
  propertyId: PropertyId,
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
