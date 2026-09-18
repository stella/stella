import { createContext, use, useMemo, useRef, useState } from "react";
import type { ComponentType, ReactNode, RefObject } from "react";

import { flexRender, useTable } from "@tanstack/react-table";
import type { RowSelectionState } from "@tanstack/react-table";
import { panic } from "better-result";
import {
  CalendarIcon,
  CircleDotIcon,
  FlagIcon,
  ListChecksIcon,
  ShapesIcon,
  TextIcon,
  UsersIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { isTaskStatus, TASK_STATUS } from "@stll/api-contract";
import { ENTITY_VIEW_COLUMNS } from "@stll/api-contract/entity-views";
import { UserText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { ReviewStatusBadge } from "@stll/ui/review-status-badge";
import { cn } from "@stll/ui/utils";
import type { SortableProperty } from "@stll/workspace-ui/sorts";

import { SignalCard } from "@/components/inbox/signal-card";
import { openInspectorSelection } from "@/components/inspector/inspector-actions";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import { MattersNavIcon } from "@/components/matter-icon";
import { MatterRefLink } from "@/components/matter-ref-link";
import { UserIdentity } from "@/components/user-avatar";
import { EntityKindIcon } from "@/components/workspaces/entity-kind-icon";
import { getEntityName } from "@/components/workspaces/entity-utils";
import { ColumnToggle } from "@/components/workspaces/table/column-toggle";
import { TableGroupHeader } from "@/components/workspaces/table/group-header";
import { MetadataPopover } from "@/components/workspaces/table/metadata-popover";
import { MobileTableOrientationGate } from "@/components/workspaces/table/mobile-table-orientation-gate";
import type {
  TableRowHost,
  TableRowRenderInput,
} from "@/components/workspaces/table/row-host";
import { workspaceTableFeatures } from "@/components/workspaces/table/table-features";
import { DEFAULT_TABLE_COLUMN_MIN_SIZE } from "@/components/workspaces/table/table-schema";
import type { TableColumnDef } from "@/components/workspaces/table/types";
import { useTableState } from "@/components/workspaces/table/use-table-state";
import {
  WorkspaceGridCell,
  WorkspaceGridRow,
} from "@/components/workspaces/table/workspace-grid";
import { getOrderedCells } from "@/components/workspaces/table/workspace-grid-order";
import { RowEndFillerCell } from "@/components/workspaces/table/workspace-table/end-fillers";
import { PinnedBoundary } from "@/components/workspaces/table/workspace-table/internals";
import {
  getGridPinningStyles,
  isPinnedBoundaryColumn,
} from "@/components/workspaces/table/workspace-table/internals-helpers";
import { WorkspaceTable } from "@/components/workspaces/table/workspace-table/workspace-table";
import { isTaskOverdue } from "@/components/workspaces/tasks/task-overdue";
import {
  INBOX_SIGNAL_VIEW,
  inboxSignalTabId,
} from "@/features/inbox/signal-inspector.logic";
import { useFormatter } from "@/i18n/formatting-context";
import type { TranslationKey } from "@/i18n/types";
import type { WorkspaceView } from "@/lib/types";
import type { TableContentMode } from "@/lib/workspaces/table-store";
import { useTableStore } from "@/lib/workspaces/table-store";

import {
  ENTITY_VIEW_GROUP,
  entryId,
  entryDueDate,
  entryStatus,
  entryType,
  entityViewSortValues,
  isEntityViewSortColumn,
} from "./model";
import { NewEntityViewTask } from "./new-task";
import { useEntityTableGroups } from "./table-groups";
import type { EntityViewEntry, EntityViewRow, EntityViewScope } from "./types";
import { WorkRiskBadge } from "./work-risk-badge";

const COLUMN_MODEL = {
  _name: { label: "common.name", icon: TextIcon, size: 300 },
  _matter: { label: "common.matter", icon: MattersNavIcon, size: 200 },
  "_agenda-kind": { label: "common.type", icon: ShapesIcon, size: 130 },
  _status: { label: "tasks.status", icon: CircleDotIcon, size: 140 },
  _priority: { label: "tasks.priority", icon: FlagIcon, size: 130 },
  "_due-date": { label: "tasks.dueDate", icon: CalendarIcon, size: 150 },
  _assignee: { label: "common.assignee", icon: UsersIcon, size: 180 },
  _actions: { label: "common.actions", icon: ListChecksIcon, size: 240 },
} as const satisfies Record<
  keyof typeof ENTITY_VIEW_COLUMNS,
  {
    label: TranslationKey;
    icon: ComponentType<{ className?: string }>;
    size: number;
  }
>;
type CollectionColumn = keyof typeof COLUMN_MODEL;
export const useEntityViewSortProperties = (): SortableProperty[] => {
  const t = useTranslations();
  const properties: SortableProperty[] = [];
  for (const id of Object.keys(COLUMN_MODEL)) {
    if (!isCollectionColumn(id)) {
      panic(`Unknown collection column: ${id}`);
    }
    if (!isEntityViewSortColumn(id)) {
      continue;
    }
    let type: SortableProperty["type"] = "single-select";
    if (id === "_due-date") {
      type = "date";
    }
    if (id === "_name") {
      type = "text";
    }
    properties.push({
      id,
      name: t(COLUMN_MODEL[id].label),
      type,
    });
  }
  return properties;
};

const EMPTY_SIZING = {};

type CollectionRenderContextValue = {
  organizationId: string;
  onChanged: () => Promise<void>;
};
const CollectionRenderContext =
  createContext<CollectionRenderContextValue | null>(null);

export const EntityViewColumnToggle = ({
  view,
  onLayoutChange,
}: Pick<EntityViewTableProps, "view" | "onLayoutChange">) => {
  const t = useTranslations();
  return (
    <ColumnToggle
      groups={[
        {
          id: "entity-view",
          label: t("common.columns"),
          columns: Object.entries(COLUMN_MODEL).map(([id, model]) => ({
            id,
            name: t(model.label),
            icon: <model.icon className="size-3.5" />,
          })),
        },
      ]}
      hidden={view.layout.hiddenProperties}
      onChange={(hiddenProperties) =>
        onLayoutChange({ ...view.layout, hiddenProperties })
      }
    />
  );
};

export type EntityViewTableProps = {
  rows: EntityViewRow[];
  view: WorkspaceView<"table">;
  onLayoutChange: (layout: WorkspaceView<"table">["layout"]) => void;
  organizationId: string;
  scope: EntityViewScope;
  onChanged: () => Promise<void>;
  loading: boolean;
  hasNextPage: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
};

export const EntityViewTable = ({
  rows,
  view,
  onLayoutChange,
  organizationId,
  scope,
  onChanged,
  loading,
  hasNextPage,
  loadingMore,
  onLoadMore,
}: EntityViewTableProps) => {
  const t = useTranslations();
  const scopeId = `entity-view:${organizationId}`;
  const sizing = useTableStore(
    (state) => state.columnSizing[scopeId]?.[view.id] ?? EMPTY_SIZING,
  );
  const setSizing = useTableStore((state) => state.setColumnSizing);
  const contentMode = useTableStore(
    (state) => state.contentMode[scopeId]?.[view.id] ?? "tight",
  );
  const [selection, setSelection] = useState<RowSelectionState>({});
  const { layout } = view;
  const tableState = useTableState({
    columnLayout: {
      hidden: layout.hiddenProperties,
      order: layout.columnOrder,
      pinned: layout.columnPinning,
      onChange: ({ hidden, order, pinned }) =>
        onLayoutChange({
          ...layout,
          ...(hidden === undefined ? {} : { hiddenProperties: [...hidden] }),
          ...(order === undefined ? {} : { columnOrder: [...order] }),
          ...(pinned === undefined ? {} : { columnPinning: [...pinned] }),
        }),
    },
    columnSizing: {
      sizing,
      onChange: (next) =>
        setSizing({ workspaceId: scopeId, viewId: view.id }, next),
    },
    rowSelection: { selection, onChange: setSelection },
    sorting: {
      sorts: layout.sorts.map(({ propertyId, desc }) => ({
        id: propertyId,
        desc,
      })),
      onChange: (sorts) =>
        onLayoutChange({
          ...layout,
          sorts: sorts.map(({ id, desc }) => ({ propertyId: id, desc })),
        }),
    },
  });
  // TanStack's controlled table requires stable definitions between state updates.
  const columns = useMemo(
    () =>
      Object.entries(COLUMN_MODEL).map(
        ([column, model]): TableColumnDef<EntityViewRow> => {
          if (!isCollectionColumn(column)) {
            return panic(`Unknown collection column: ${column}`);
          }
          const columnId = column;
          return {
            id: columnId,
            size: model.size,
            minSize: DEFAULT_TABLE_COLUMN_MIN_SIZE,
            enableSorting: ENTITY_VIEW_COLUMNS[columnId].sortable,
            accessorFn: ({ entry }) =>
              isEntityViewSortColumn(columnId)
                ? entityViewSortValues[columnId](entry)
                : null,
            enableHiding: true,
            enablePinning: true,
            enableResizing: true,
            header: ({ header }) => (
              <MetadataPopover
                column={header.column}
                icon={model.icon}
                label={t(model.label)}
              />
            ),
            cell: ({ row }) => (
              <CollectionCell column={columnId} entry={row.original.entry} />
            ),
          };
        },
      ),
    [t],
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const groups = useEntityTableGroups(rows, layout.groupByPropertyId);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(key)) {
        next.add(key);
      }
      return next;
    });
  const sectionProps = { columns, tableState, contentMode };

  return (
    <CollectionRenderContext value={{ organizationId, onChanged }}>
      <MobileTableOrientationGate>
        {groups === null ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <TableSection
              {...sectionProps}
              rows={rows}
              loading={loading}
              bottomRow={
                <TableCreateTask
                  organizationId={organizationId}
                  scope={scope}
                  onChanged={onChanged}
                />
              }
              hasNextPage={hasNextPage}
              loadingMore={loadingMore}
              onLoadMore={onLoadMore}
            />
            {!loading && rows.length === 0 && (
              <p className="text-muted-foreground p-4 text-sm">
                {t("common.noResults")}
              </p>
            )}
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto" ref={scrollRef}>
            {loading && groups.length === 0 && (
              <TableSection
                {...sectionProps}
                loading
                outerScrollRef={scrollRef}
                rows={rows}
              />
            )}
            {groups.map(({ key, group, rows: groupRows }) => (
              <section key={key}>
                <TableGroupHeader
                  group={group}
                  collapsed={collapsed.has(key)}
                  empty={groupRows.length === 0}
                  loading={loading}
                  loadedCount={groupRows.length}
                  totalCount={null}
                  onToggle={() => toggle(key)}
                />
                {(!collapsed.has(key) || groupRows.length === 0) && (
                  <TableSection
                    {...sectionProps}
                    rows={groupRows}
                    loading={loading}
                    outerScrollRef={scrollRef}
                    bottomRow={
                      <TableCreateTask
                        organizationId={organizationId}
                        scope={scope}
                        onChanged={onChanged}
                        group={{
                          field: layout.groupByPropertyId ?? "",
                          value: group.value,
                        }}
                      />
                    }
                  />
                )}
              </section>
            ))}
            {hasNextPage && (
              <Button
                disabled={loadingMore}
                onClick={onLoadMore}
                variant="ghost"
              >
                {t(loadingMore ? "common.loading" : "common.loadMore")}
              </Button>
            )}
            {!loading && groups.length === 0 && (
              <TableCreateTask
                organizationId={organizationId}
                scope={scope}
                onChanged={onChanged}
              />
            )}
          </div>
        )}
      </MobileTableOrientationGate>
    </CollectionRenderContext>
  );
};

type TableSectionProps = {
  rows: EntityViewRow[];
  columns: TableColumnDef<EntityViewRow>[];
  tableState: ReturnType<typeof useTableState>;
  contentMode: TableContentMode;
  loading: boolean;
  bottomRow?: ReactNode;
  hasNextPage?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  outerScrollRef?: RefObject<HTMLDivElement | null>;
};

const TableSection = ({
  rows,
  columns,
  tableState,
  contentMode,
  loading,
  hasNextPage = false,
  loadingMore = false,
  onLoadMore,
  outerScrollRef,
  bottomRow,
}: TableSectionProps) => {
  const table = useTable({
    features: workspaceTableFeatures,
    data: rows,
    columns,
    columnResizeMode: "onChange",
    manualSorting: true,
    defaultColumn: { minSize: DEFAULT_TABLE_COLUMN_MIN_SIZE },
    getRowId: ({ entry }) => entryId(entry),
    state: tableState.state,
    ...tableState.listeners,
  });
  const rowHost: TableRowHost<EntityViewRow> = {
    renderRow: (input) => <CollectionRow {...input} />,
    ...(bottomRow === undefined ? {} : { bottomRow }),
  };
  return (
    <WorkspaceTable
      contentMode={contentMode}
      fillHeight={false}
      hasNextPage={hasNextPage}
      isFetchingNextPage={loadingMore}
      {...(onLoadMore === undefined ? {} : { onLoadMore })}
      {...(outerScrollRef === undefined
        ? {}
        : { outerScrollRef, stickyColumnHeader: false })}
      rowHost={rowHost}
      skeletonRowCount={loading ? 8 : 0}
      table={table}
    />
  );
};

const isCollectionColumn = (value: string): value is CollectionColumn =>
  Object.hasOwn(COLUMN_MODEL, value);

const entryOpener = (entry: EntityViewEntry): (() => void) | undefined => {
  switch (entry.type) {
    case "entity":
      return openInspectorSelection({
        entities: [entry.entity],
        anchor: entry.entity,
        workspaceId: entry.workspaceId,
      });
    case "proposal":
      return () =>
        useInspectorTabsStore.getState().openView({
          type: INBOX_SIGNAL_VIEW,
          id: inboxSignalTabId(entry.signal.id),
          label: entry.signal.title,
          payload: { signalId: entry.signal.id },
        });
    default:
      entry satisfies never;
      return panic("Unknown collection entry");
  }
};

type CollectionCellProps = {
  column: CollectionColumn;
  entry: EntityViewEntry;
};

const CollectionCell = ({ column, entry }: CollectionCellProps) => {
  const context = use(CollectionRenderContext);
  if (context === null) {
    panic("Collection cell rendered outside its view");
  }
  const { organizationId, onChanged } = context;
  const t = useTranslations();
  const format = useFormatter();
  switch (column) {
    case "_name": {
      const open = entryOpener(entry);
      return (
        <button
          className="flex min-w-0 items-center gap-2 text-start"
          disabled={open === undefined}
          onClick={open}
          type="button"
        >
          {entry.type === "entity" && (
            <EntityKindIcon
              kind={entry.entity.kind}
              status={entry.entity.status ?? undefined}
            />
          )}
          <UserText className="truncate font-medium">
            {entry.type === "entity"
              ? getEntityName(entry.entity)
              : entry.signal.title}
          </UserText>
          {entry.type === "proposal" && (
            <ReviewStatusBadge tone="neutral">
              {t("flows.status.awaitingReview")}
            </ReviewStatusBadge>
          )}
          {entry.type === "entity" && <WorkRiskBadge risk={entry.workRisk} />}
        </button>
      );
    }
    case "_matter": {
      const workspaceId =
        entry.type === "entity" ? entry.workspaceId : entry.signal.workspaceId;
      const name =
        entry.type === "entity"
          ? entry.workspaceName
          : entry.signal.workspaceName;
      return workspaceId ? (
        <MatterRefLink workspaceId={workspaceId}>
          <UserText>{name ?? t("common.matter")}</UserText>
        </MatterRefLink>
      ) : null;
    }
    case "_agenda-kind": {
      const itemType = entryType(entry);
      switch (itemType) {
        case "deadline":
          return t("tasks.workTypeValues.deadline");
        case "task":
          return t("search.kinds.task");
        case "document":
          return t("common.document");
        case "folder":
          return t("search.kinds.folder");
        case null:
          return null;
        case "message":
          return t("search.kinds.message");
        case "link":
          return t("search.kinds.link");
        default:
          itemType satisfies never;
          return panic("Unknown entry type");
      }
    }
    case "_status": {
      const status = entryStatus(entry);
      return status ? t(`tasks.statusValues.${status}`) : null;
    }
    case "_priority":
      return entry.type === "entity" && entry.entity.priority
        ? t(`tasks.priorityValues.${entry.entity.priority}`)
        : null;
    case "_due-date": {
      const date = entryDueDate(entry);
      if (!date) {
        return null;
      }
      const overdue =
        entry.type === "entity" &&
        entry.entity.kind === "task" &&
        isTaskOverdue(date, entry.entity.status);
      return (
        <span className={cn(overdue && "text-destructive")}>
          {format.dateTime(new Date(`${date}T00:00:00Z`), {
            dateStyle: "medium",
            timeZone: "UTC",
          })}
        </span>
      );
    }
    case "_assignee": {
      if (entry.type === "entity") {
        return (
          <div className="flex flex-col gap-1">
            {entry.entity.assignees.map((person) => (
              <UserIdentity
                avatarClassName="size-5"
                key={person.userId}
                image={person.image}
                name={person.name}
              />
            ))}
          </div>
        );
      }
      if (!entry.signal.assigneeUserId) {
        return null;
      }
      return (
        <UserIdentity
          avatarClassName="size-5"
          image={entry.signal.assigneeUserImage}
          name={entry.signal.assigneeUserName}
        />
      );
    }
    case "_actions":
      return entry.type === "proposal" ? (
        <SignalCard
          onChanged={onChanged}
          organizationId={organizationId}
          presentation="actions"
          signal={entry.signal}
        />
      ) : null;
    default:
      column satisfies never;
      return panic("Unknown collection column");
  }
};

const CollectionRow = ({
  row,
  index,
  renderColumns,
  addPropertyColumn,
  measureElement,
}: TableRowRenderInput<EntityViewRow>) => (
  <WorkspaceGridRow
    aria-rowindex={index + 2}
    data-index={index}
    ref={measureElement}
  >
    {getOrderedCells(row.getVisibleCells(), renderColumns).map(
      (cell, columnIndex) => (
        <WorkspaceGridCell
          aria-colindex={columnIndex + 1}
          className={cn(
            isPinnedBoundaryColumn(cell.column) && "border-e-0",
            row.original.entry.type === "proposal" && "border-dashed",
          )}
          key={cell.id}
          style={{
            gridColumn: columnIndex + 1,
            ...getGridPinningStyles(cell.column),
          }}
        >
          <PinnedBoundary column={cell.column} />
          {flexRender(cell.column.columnDef.cell, cell.getContext())}
        </WorkspaceGridCell>
      ),
    )}
    <RowEndFillerCell
      addPropertyColumn={addPropertyColumn}
      renderColumns={renderColumns}
      selected={false}
    />
  </WorkspaceGridRow>
);

type TableCreateTaskProps = Pick<
  EntityViewTableProps,
  "organizationId" | "scope" | "onChanged"
> & {
  group?: { field: string; value: string | null };
};

const TableCreateTask = ({
  organizationId,
  scope,
  onChanged,
  group,
}: TableCreateTaskProps) => {
  if (group?.field === ENTITY_VIEW_GROUP.AUTHOR) {
    return null;
  }
  if (
    (group?.field === ENTITY_VIEW_GROUP.KIND ||
      group?.field === ENTITY_VIEW_GROUP.TYPE) &&
    group.value !== "task" &&
    group.value !== "deadline"
  ) {
    return null;
  }
  if (group?.field === ENTITY_VIEW_GROUP.STATUS && !isTaskStatus(group.value)) {
    return null;
  }
  if (group?.field === ENTITY_VIEW_GROUP.MATTER && group.value === null) {
    return null;
  }
  let workspaceId = scope.type === "matter" ? scope.matterId : null;
  if (group?.field === ENTITY_VIEW_GROUP.MATTER) {
    workspaceId = group.value;
  }
  return (
    <div className="p-2" style={{ gridColumn: "1 / -1" }}>
      <NewEntityViewTask
        organizationId={organizationId}
        workspaceId={workspaceId}
        status={
          group?.field === ENTITY_VIEW_GROUP.STATUS && isTaskStatus(group.value)
            ? group.value
            : TASK_STATUS.OPEN
        }
        agendaKind={
          group?.field === ENTITY_VIEW_GROUP.TYPE && group.value === "deadline"
            ? "deadline"
            : "task"
        }
        {...(group?.field === ENTITY_VIEW_GROUP.ASSIGNEE
          ? { assigneeUserId: group.value }
          : {})}
        onChanged={onChanged}
      />
    </div>
  );
};
