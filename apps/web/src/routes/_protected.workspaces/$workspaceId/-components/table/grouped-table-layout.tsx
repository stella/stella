import {
  type RefObject,
  useCallback,
  useDeferredValue,
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
import { SearchXIcon, TableIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { ENTITY_KINDS, VIEW_SORTS_MAX } from "@stll/api-contract";
import type { KanbanGroup } from "@stll/ui/kanban";
import {
  getKanbanGroupingPropertyId,
  getKanbanGroups,
  resolveKanbanGroupOptions,
} from "@stll/ui/kanban";
import { Skeleton } from "@stll/ui/skeleton";
import { cn } from "@stll/ui/utils";

import {
  getInternalPropertyId,
  toTableEntities,
} from "@/components/workspaces/entity-utils";
import { useSyncJustificationChunks } from "@/components/workspaces/hooks/use-sync-justifications";
import {
  isGroupableProperty,
  resolveWorkspaceKanbanGrouping,
} from "@/components/workspaces/kanban/kanban-view.logic";
import { useWorkspaceKanbanSchema } from "@/components/workspaces/kanban/use-kanban-schema";
import { FindHighlightScope } from "@/components/workspaces/table/find-highlight";
import {
  buildDocTypeGateLabels,
  resolveDocumentTypeClassifier,
  selectGroupColumns,
} from "@/components/workspaces/table/group-columns";
import { TableGroupHeader } from "@/components/workspaces/table/group-header";
import { MobileTableOrientationGate } from "@/components/workspaces/table/mobile-table-orientation-gate";
import { workspaceTableFeatures } from "@/components/workspaces/table/table-features";
import { DEFAULT_TABLE_COLUMN_MIN_SIZE } from "@/components/workspaces/table/table-schema";
import type {
  TableColumnDef,
  TableTreeNode,
} from "@/components/workspaces/table/types";
import { useEntityTableFind } from "@/components/workspaces/table/use-entity-table-find";
import {
  WorkspaceGridCell,
  WorkspaceGridHead,
  WorkspaceGridRow,
} from "@/components/workspaces/table/workspace-grid";
import { getOrderedColumns } from "@/components/workspaces/table/workspace-grid-order";
import { AddPropertyRailSpacer } from "@/components/workspaces/table/workspace-table/end-fillers";
import { HeaderEndFillerCell } from "@/components/workspaces/table/workspace-table/header-cells";
import {
  TABLE_ROW_ESTIMATE_PX,
  type WorkspaceGridStyle,
} from "@/components/workspaces/table/workspace-table/internals";
import {
  addPropertyColId,
  getEndFillerGridColumn,
  getScrollableAncestor,
  getWorkspaceGridTemplateColumns,
  tableEndFillerCellStyle,
} from "@/components/workspaces/table/workspace-table/internals-helpers";
import { WorkspaceTableSkeletonRows } from "@/components/workspaces/table/workspace-table/skeleton-rows";
import { WorkspaceTable } from "@/components/workspaces/table/workspace-table/workspace-table";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { detached } from "@/lib/detached";
import type { EntityKind, WorkspaceView } from "@/lib/types";
import { visibleEntityFieldIds } from "@/lib/workspaces/queries/entities";
import type { EntitiesFindKey } from "@/lib/workspaces/queries/entities.logic";
import { propertiesOptions } from "@/lib/workspaces/queries/properties";
import { workspaceTableAdapter } from "@/lib/workspaces/table-adapter";
import { useTableStore } from "@/lib/workspaces/table-store";
import { BottomRow } from "@/routes/_protected.workspaces/$workspaceId/-components/bottom-row";
import { EmptyState } from "@/routes/_protected.workspaces/$workspaceId/-components/empty-state";
import { useEntityRowHost } from "@/routes/_protected.workspaces/$workspaceId/-components/table/entity-row-host";
import { GroupScopeProvider } from "@/routes/_protected.workspaces/$workspaceId/-components/table/group-scope";
import {
  getGroupSkeletonLayout,
  GROUP_TABLE_PAGE_SIZE,
} from "@/routes/_protected.workspaces/$workspaceId/-components/table/grouped-table-layout.logic";
import { useTableColumns } from "@/routes/_protected.workspaces/$workspaceId/-components/table/table-columns";
import { includesListItems } from "@/routes/_protected.workspaces/$workspaceId/-components/view/view-kind-filters";
import { useSyncSelectedEntities } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-sync-selected-entities";
import { useViewColumnLayout } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-view-column-layout";
import { useViewTableState } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-view-table-state";

// Grouped views eager-load only the first few sections' rows upfront; every
// later section rides its IntersectionObserver scroll-gate (400px lookahead)
// so it loads as it nears the viewport. This caps the initial burst of
// per-section /kanban-group fetches instead of firing one per group at once.
const GROUP_EAGER_LOAD_COUNT = 3;

// A grouped document table never lists folders or tasks as rows, matching the
// flat window query; passed to the kanban-group endpoint so its rows (and the
// group-counts) stay in sync.
const GROUPED_TABLE_KIND_DISPOSITION = {
  document: "included",
  folder: "excluded",
  task: "excluded",
  message: "included",
  link: "included",
} as const satisfies Record<EntityKind, "excluded" | "included">;

const isGroupedTableExcludedKind = (kind: EntityKind): boolean =>
  GROUPED_TABLE_KIND_DISPOSITION[kind] === "excluded";

const GROUPED_TABLE_EXCLUDED_KINDS = ENTITY_KINDS.filter(
  isGroupedTableExcludedKind,
);

// Stable key for a group. The null (uncategorized) bucket and real string values
// live in disjoint namespaces so an option literally named "uncategorized"
// can't collide with the null bucket.
const groupKeyFor = (value: string | null): string =>
  value === null ? "uncategorized" : `value:${value}`;

const getEagerGroupValues = (
  groups: KanbanGroup[],
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
  const columnLayout = useViewColumnLayout({ workspaceId, view });
  const tableState = useViewTableState({ workspaceId, view, columnLayout });
  const columns = useTableColumns({ properties, view });
  // Deferred alongside the group keys (each section defers its own), so the
  // marks describe the rows on screen, not a term still being fetched.
  const find = useDeferredValue(
    useEntityTableFind({
      hasNameColumn: includesListItems(view.layout.filters),
      hiddenProperties: view.layout.hiddenProperties,
      properties,
      view: { workspaceId, viewId: view.id },
    }),
  );
  // One shared scroller for the whole grouped view: every group's table flows
  // inside it (no nested scroll boxes), so the sticky group headers stack
  // correctly and a single horizontal scroll keeps every group aligned.
  const scrollRef = useRef<HTMLDivElement>(null);

  const groupByConfig = view.layout.groupByPropertyId ?? "";
  const schema = useWorkspaceKanbanSchema(properties);
  const grouping = useMemo(
    () => resolveWorkspaceKanbanGrouping(groupByConfig, schema),
    [groupByConfig, schema],
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
        : new Map<string, Set<string>>(),
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
    (grouping.type === "built-in" &&
      grouping.group.id !== getInternalPropertyId("kind")) ||
    (grouping.type === "property" && !isGroupableProperty(grouping.property));

  // One query for every group's count, so a group only fires its row query
  // when it actually has rows (empty groups never round-trip).
  const groupCounts = useQuery({
    ...workspaceTableAdapter.sectionCounts({
      workspaceId,
      filters: view.layout.filters,
      groupByPropertyId: groupByPropertyId ?? "",
      ...(optionValues !== undefined && { optionValues }),
      ...find.request,
    }),
    enabled: groupByPropertyId !== null && !isUnsupportedGrouping,
  });
  const countByValue = useMemo(() => {
    const map = new Map<string | null, number>();
    if (groupCounts.data) {
      for (const entry of groupCounts.data) {
        map.set(entry.value, entry.count);
      }
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
  useSyncSelectedEntities({
    workspaceId,
    viewId: view.id,
    treeData: allTreeData,
  });
  // Every row id across all sections, so a section's select-all keeps the other
  // sections' selections (they share one selection) without resurrecting stale
  // ids.
  const allRowIds = useMemo(
    () => allTreeData.map((node) => node.entityId),
    [allTreeData],
  );
  // The cross-group row-id union grows as each group's first page lands, so
  // passing it as a prop would re-render every section on every group load
  // (each rebuilding its table). Sections only need it inside the "select
  // all" click handler, never during render, so publish it to the table
  // store instead: `WorkspaceTable` reads it imperatively
  // (`useTableStore.getState()`) at click time rather than subscribing, so
  // the per-load re-render fan-out disappears. (An Effect Event is the wrong
  // tool here — it may only be called from an Effect in the component that
  // defines it, not threaded through props and invoked from a click handler
  // several components away.)
  useExternalSyncEffect(() => {
    useTableStore
      .getState()
      .setPreservableRowIds({ workspaceId, viewId: view.id }, allRowIds);
  }, [workspaceId, view.id, allRowIds]);

  if (groupByPropertyId === null || isUnsupportedGrouping) {
    return (
      <EmptyState
        icon={TableIcon}
        message={t("workspaces.views.selectProperty")}
        workspaceId={workspaceId}
      />
    );
  }

  const options = resolveKanbanGroupOptions(grouping);
  // Cells whose value is no longer a current option fold into the uncategorized
  // group server-side (the row/count queries treat "no current-option value" as
  // uncategorized), so the sections are just the option groups plus uncategorized.
  const groups = getKanbanGroups(options, t("common.uncategorized"));
  const eagerGroupValues = countsLoaded
    ? getEagerGroupValues(groups, countByValue)
    : null;

  // A find that matches nothing gets the same answer here as in the flat
  // layout. Left to the sections, a grouped view says it with a column of
  // "0 items" headers and no term in sight, so the same search reads as two
  // different outcomes depending on how the view happens to be grouped.
  if (
    find.highlight &&
    countsLoaded &&
    groups.every((group) => (countByValue.get(group.value) ?? 0) === 0)
  ) {
    return (
      <EmptyState
        hint={t("workspaces.views.noFindResultsHint")}
        icon={SearchXIcon}
        message={t("workspaces.views.noFindResults", {
          term: find.highlight.term,
        })}
      />
    );
  }

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
      <FindHighlightScope highlight={find.highlight}>
        <div className="flex w-max min-w-full flex-col" ref={scrollRef}>
          {groups.map((group) => (
            <GroupSection
              columns={columns}
              count={
                countsLoaded ? (countByValue.get(group.value) ?? 0) : undefined
              }
              eager={eagerGroupValues?.has(group.value) ?? false}
              fieldIds={fieldIds}
              find={find.request}
              gateLabelsByColumnId={gateLabelsByColumnId}
              group={group}
              groupByPropertyId={groupByPropertyId}
              key={groupKeyFor(group.value)}
              optionValues={optionValues}
              outerScrollRef={scrollRef}
              reportGroupTreeData={reportGroupTreeData}
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
      </FindHighlightScope>
    </MobileTableOrientationGate>
  );
};

const NO_ROWS: TableTreeNode[] = [];

// Shared column geometry for the rows that live OUTSIDE a group's own table
// (the bottom add-row and the loading skeleton): a data-less table supplies the
// column sizes so they line up with the group tables above.
const useGroupGridGeometry = (
  columns: TableColumnDef[],
  tableState: ReturnType<typeof useViewTableState>,
) => {
  const table = useTable({
    features: workspaceTableFeatures,
    columnResizeMode: "onChange",
    data: NO_ROWS,
    columns,
    defaultColumn: { minSize: DEFAULT_TABLE_COLUMN_MIN_SIZE },
    manualSorting: true,
    maxMultiSortColCount: VIEW_SORTS_MAX,
    enableSortingRemoval: false,
    enableSubRowSelection: true,
    getRowId: (row) => row.entityId,
    state: tableState.state,
  });

  const orderedColumns = getOrderedColumns({
    startColumns: table.getStartLeafColumns(),
    centerColumns: table.getCenterLeafColumns(),
    endColumns: table.getEndLeafColumns(),
  }).filter((column) => column.getIsVisible());
  const addPropertyColumn =
    orderedColumns.find((column) => column.id === addPropertyColId) ?? null;
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
      addPropertyColumn,
    }),
    minWidth: tableWidth,
  };

  return { table, renderColumns, addPropertyColumn, gridStyle };
};

type GroupedAddRowProps = {
  columns: TableColumnDef[];
  tableState: ReturnType<typeof useViewTableState>;
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

type GroupSkeletonProps = {
  columns: TableColumnDef[];
  tableState: ReturnType<typeof useViewTableState>;
  totalRows: number | undefined;
};

// Placeholder rows in the real column grid, shown while a group's count (or its
// rows) are still loading — so the view never flashes "0 items". Once the
// authoritative count is known, reserve the first page's exact height while
// keeping the animated skeleton DOM bounded; the ruled filler represents the
// remaining rows without mounting hundreds of placeholders per group.
const GroupSkeleton = ({
  columns,
  tableState,
  totalRows,
}: GroupSkeletonProps) => {
  const { renderColumns, addPropertyColumn, gridStyle } = useGroupGridGeometry(
    columns,
    tableState,
  );
  const { fillerRowCount, skeletonRowCount } =
    getGroupSkeletonLayout(totalRows);

  return (
    <div style={gridStyle}>
      <WorkspaceGridRow className="pointer-events-none">
        {renderColumns.map((column) => (
          <WorkspaceGridHead
            className="flex items-center px-2"
            key={column.id}
            role="presentation"
          >
            <Skeleton className="h-3.5 w-2/5" />
          </WorkspaceGridHead>
        ))}
        <HeaderEndFillerCell
          addPropertyColumn={addPropertyColumn}
          renderColumns={renderColumns}
        />
      </WorkspaceGridRow>
      <WorkspaceTableSkeletonRows
        addPropertyColumn={addPropertyColumn}
        renderColumns={renderColumns}
        rowCount={skeletonRowCount}
      />
      {fillerRowCount > 0 && (
        <WorkspaceGridRow
          className="pointer-events-none"
          style={{ height: fillerRowCount * TABLE_ROW_ESTIMATE_PX }}
        >
          {renderColumns.map((column) => (
            <WorkspaceGridCell
              className="min-h-0 border-b-0 p-0"
              key={column.id}
              role="presentation"
              style={tableEndFillerCellStyle}
            />
          ))}
          <WorkspaceGridCell
            className="min-h-0 border-e-0 border-b-0 p-0"
            role="presentation"
            style={{
              gridColumn: getEndFillerGridColumn({
                renderColumns,
                addPropertyColumn,
              }),
              ...tableEndFillerCellStyle,
            }}
          />
          {addPropertyColumn && (
            <AddPropertyRailSpacer
              height={fillerRowCount * TABLE_ROW_ESTIMATE_PX}
            />
          )}
        </WorkspaceGridRow>
      )}
    </div>
  );
};

type GroupSectionProps = {
  workspaceId: string;
  view: WorkspaceView<"table">;
  group: KanbanGroup;
  groupByPropertyId: string;
  optionValues: string[] | undefined;
  // Authoritative row count from the one upfront group-counts query;
  // `undefined` while that query is still loading.
  count: number | undefined;
  // Skip the lazy scroll-gate and load this section's rows upfront.
  eager: boolean;
  fieldIds: string[];
  // The view's find, resolved once by the layout so every section asks the
  // same question its group count was answered with.
  find: EntitiesFindKey;
  columns: TableColumnDef[];
  // propertyId -> document-type labels its column is gated to, for per-section
  // column selection when grouped by the "Document Type" classifier. Empty for
  // other groupings (every section then renders the full column set).
  gateLabelsByColumnId: Map<string, Set<string>>;
  tableState: ReturnType<typeof useViewTableState>;
  outerScrollRef: RefObject<HTMLDivElement | null>;
  reportGroupTreeData: (groupKey: string, nodes: TableTreeNode[]) => void;
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
  find,
  columns,
  gateLabelsByColumnId,
  tableState,
  outerScrollRef,
  reportGroupTreeData,
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
    ...workspaceTableAdapter.useSectionPage({
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
      ...find,
    }),
    enabled: hasRows && (eager || hasScrolledIntoView),
  });

  // When a group empties (its last row moved/deleted), the count is 0 and the
  // query is disabled, but React Query can still hold cached pages for this key.
  // Drop them when the group has no rows so stale rows aren't published to the
  // selection union or rendered.
  const entities = useMemo(() => {
    if (!hasRows || !query.data) {
      return [];
    }
    return query.data.pages.flatMap((page) => page.entities);
  }, [hasRows, query.data]);
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
  const justificationEntityIdChunks = useMemo(() => {
    if (!query.data) {
      return [];
    }
    return query.data.pages.map((page) =>
      page.entities.map((entity) => entity.entityId),
    );
  }, [query.data]);
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
    maxMultiSortColCount: VIEW_SORTS_MAX,
    enableSortingRemoval: false,
    enableSubRowSelection: true,
    getRowId: (row) => row.entityId,
    state: tableState.state,
    ...tableState.listeners,
  });
  const rowHost = useEntityRowHost({
    workspaceId,
    table,
    viewId: view.id,
    addRow: false,
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
      <TableGroupHeader
        collapsed={collapsed}
        empty={isEmpty}
        group={group}
        loadedCount={loadedCount}
        loading={isLoadingCounts}
        onToggle={() => setCollapsed((prev) => !prev)}
        totalCount={count ?? null}
      />
      {!collapsed && showSkeleton && (
        <GroupSkeleton
          columns={sectionColumns}
          tableState={tableState}
          totalRows={count}
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
                  detached(
                    query.fetchNextPage(),
                    "grouped-table-layout.fetch-next-page",
                  );
                }
              }}
              outerScrollRef={outerScrollRef}
              rowHost={rowHost}
              stickyColumnHeader={false}
              table={table}
            />
          </GroupScopeProvider>
        )}
    </section>
  );
};
