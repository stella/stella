import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  draggable,
  dropTargetForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { setCustomNativeDragPreview } from "@atlaskit/pragmatic-drag-and-drop/element/set-custom-native-drag-preview";
import { Checkbox } from "@stll/ui/components/checkbox";
import { toastManager } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";
import { flexRender } from "@tanstack/react-table";
import type { Table as ReactTable, Row } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ChevronRightIcon,
  FolderIcon,
  FolderOpenIcon,
  PlusIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { renderDragPreview } from "@/components/drag-preview";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/table";
import { BottomRow } from "@/routes/_protected.workspaces/$workspaceId/-components/bottom-row";
import { CreateProperty } from "@/routes/_protected.workspaces/$workspaceId/-components/create-property";
import { ENTITY_DRAG_TYPE } from "@/routes/_protected.workspaces/$workspaceId/-components/drag-constants";
import { InlineEdit } from "@/routes/_protected.workspaces/$workspaceId/-components/inline-edit";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import { RowActions } from "@/routes/_protected.workspaces/$workspaceId/-components/row-actions";
import type { VirtualAnchor } from "@/routes/_protected.workspaces/$workspaceId/-components/row-actions";
import type {
  TableTreeNode,
  WorkspaceTable as WorkspaceTableType,
} from "@/routes/_protected.workspaces/$workspaceId/-components/table/types";
import { useInspectorFlash } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-inspector-flash";
import { useRenameEntity } from "@/routes/_protected.workspaces/$workspaceId/-mutations/entities";
import {
  countDescendants,
  getEntityName,
  getFirstFile,
  getInternalColId,
  getPinningStyles,
} from "@/routes/_protected.workspaces/$workspaceId/-utils";

const selectColId = getInternalColId("select");
const addPropertyColId = getInternalColId("add-property");
const TABLE_ROW_ESTIMATE_PX = 41;
const TABLE_ROW_OVERSCAN = 16;

type WorkspaceTableProps = {
  workspaceId: string;
  table: WorkspaceTableType;
  hasNextPage?: boolean;
  isFetchingNextPage?: boolean;
  onLoadMore?: () => void;
};

export const WorkspaceTable = ({
  workspaceId,
  table,
  hasNextPage = false,
  isFetchingNextPage = false,
  onLoadMore,
}: WorkspaceTableProps) => {
  const t = useTranslations();
  const tableWrapperRef = useRef<HTMLDivElement>(null);
  const lastSelectedIndex = useRef<number | null>(null);
  const [editingEntityId, setEditingEntityId] = useState<string | null>(null);
  // Single shared dialog so the "+" header AND every body cell of
  // the add-property column open the same composer instead of each
  // mounting its own.
  const [addColumnOpen, setAddColumnOpen] = useState(false);
  const openAddColumn = useCallback(() => setAddColumnOpen(true), []);

  const renameEntity = useRenameEntity();

  const activeEntityId = useInspectorStore((s) => {
    if (!s.activeId) {
      return null;
    }
    const tab = s.tabs.find((candidate) => candidate.id === s.activeId);
    return tab?.type === "pdf" ? tab.entityId : null;
  });

  const activeTaskId = useInspectorStore((s) => {
    if (!s.activeId) {
      return null;
    }
    const tab = s.tabs.find((candidate) => candidate.id === s.activeId);
    return tab?.type === "task" ? tab.id : null;
  });

  const rowModel = table.getRowModel();

  const rowLabels = useMemo(() => {
    // Compute logical row labels that account for collapsed
    // folder children. Each visible row gets a 1-based number;
    // collapsed folders show a range.
    const labels: string[] = [];
    let logicalPos = 1;
    for (const row of rowModel.rows) {
      const isFolder = row.original.kind === "folder";
      const isCollapsed = isFolder && !row.getIsExpanded();

      if (isCollapsed) {
        const descendantCount = countDescendants(row.original);
        if (descendantCount > 0) {
          labels.push(`${logicalPos}-${logicalPos + descendantCount}`);
          logicalPos += descendantCount + 1;
        } else {
          labels.push(String(logicalPos));
          logicalPos += 1;
        }
      } else {
        labels.push(String(logicalPos));
        logicalPos += 1;
      }
    }
    return labels;
  }, [rowModel]);
  const getVirtualRowKey = useCallback(
    (index: number) =>
      rowModel.rows.at(index)?.original.entityId ?? `table-row-${index}`,
    [rowModel.rows],
  );
  const rowVirtualizer = useVirtualizer({
    count: rowModel.rows.length,
    getScrollElement: () => tableWrapperRef.current,
    estimateSize: () => TABLE_ROW_ESTIMATE_PX,
    getItemKey: getVirtualRowKey,
    overscan: TABLE_ROW_OVERSCAN,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const lastVirtualRow = virtualRows.at(-1);
  useEffect(() => {
    if (!hasNextPage || isFetchingNextPage || !onLoadMore || !lastVirtualRow) {
      return;
    }

    const shouldLoadMore =
      lastVirtualRow.index >= rowModel.rows.length - 1 - TABLE_ROW_OVERSCAN;
    if (shouldLoadMore) {
      onLoadMore();
    }
  }, [
    hasNextPage,
    isFetchingNextPage,
    lastVirtualRow,
    onLoadMore,
    rowModel.rows.length,
  ]);
  const paddingTop = virtualRows.at(0)?.start ?? 0;
  const paddingBottom =
    rowVirtualizer.getTotalSize() - (virtualRows.at(-1)?.end ?? 0);
  const visibleColumns = table.getVisibleLeafColumns();
  const visibleColumnCount = visibleColumns.length;
  const tableWidth = table.getTotalSize();

  useEffect(() => {
    const element = tableWrapperRef.current;
    if (!element) {
      return undefined;
    }

    return dropTargetForElements({
      element,
      canDrop: ({ source }) => source.data["type"] === ENTITY_DRAG_TYPE,
      onDrop: ({ source }) => {
        if (source.data["type"] !== ENTITY_DRAG_TYPE) {
          return;
        }
        toastManager.add({
          title: t("workspaces.table.reorderReadOnly"),
          type: "info",
        });
      },
    });
  }, [t]);

  return (
    <div className="relative h-full flex-1 overflow-auto" ref={tableWrapperRef}>
      <Table
        className="[&_td]:border-border [&_th]:border-border [&:has([data-add-cell]:hover)_[data-add-col]]:bg-muted! [&:has([data-add-cell]:hover)_td:not([data-add-col]),&:has([data-add-cell]:hover)_th:not([data-add-col])]:bg-background! table-fixed border-separate border-spacing-0 [&_td:has([data-slot=select-trigger])]:min-w-40 [&_tfoot_td]:border-t [&_th]:border-b [&_tr]:border-none [&_tr:not(:nth-last-child(2))_td]:border-b"
        style={{
          // Render at natural column-sum width. With `table-fixed`,
          // forcing `width: 100%` stretched the <table> past the
          // last column, leaving an empty band of "table" beyond
          // the "+" header. The wrapper's overflow handles scroll
          // when columns exceed the viewport.
          width: tableWidth,
        }}
      >
        <colgroup>
          {visibleColumns.map((column) => (
            <col key={column.id} style={{ width: column.getSize() }} />
          ))}
        </colgroup>
        <TableHeader className="bg-background sticky top-0 z-30 border-b">
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => {
                const isAddPropertyHeader =
                  header.column.id === addPropertyColId;
                return (
                  <TableHead
                    className={cn(
                      "group/table-head bg-background hover:bg-background relative h-10 border-t px-0",
                      header.column.getIsResizing() &&
                        "after:bg-info after:pointer-events-none after:absolute after:top-0 after:right-0 after:bottom-0 after:z-50 after:w-px",
                    )}
                    colSpan={header.colSpan}
                    {...(isAddPropertyHeader ? { "data-add-col": "" } : {})}
                    key={header.id}
                    style={{
                      ...getPinningStyles(header.column),
                    }}
                  >
                    {header.isPlaceholder ? null : isAddPropertyHeader ? (
                      <button
                        aria-label={t("workspaces.properties.newColumn")}
                        className="text-muted-foreground hover:text-foreground flex h-full w-full items-center justify-center transition-colors"
                        data-add-cell
                        onClick={openAddColumn}
                        title={t("workspaces.properties.newColumn")}
                        type="button"
                      >
                        <PlusIcon className="size-4" />
                      </button>
                    ) : (
                      flexRender(
                        header.column.columnDef.header,
                        header.getContext(),
                      )
                    )}
                    {header.column.getCanResize() && (
                      <button
                        className="user-select-none absolute top-0 -right-2 z-30 hidden h-full w-4 cursor-col-resize touch-none py-1 group-hover/table-head:flex"
                        onDoubleClick={() => header.column.resetSize()}
                        onMouseDown={header.getResizeHandler()}
                        onTouchStart={header.getResizeHandler()}
                        type="button"
                      >
                        <span className="bg-primary/25 mr-auto h-full w-1 rounded" />
                      </button>
                    )}
                  </TableHead>
                );
              })}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {paddingTop > 0 && (
            <TableRow aria-hidden="true">
              <TableCell
                colSpan={visibleColumnCount}
                style={{ height: paddingTop, padding: 0 }}
              />
            </TableRow>
          )}
          {virtualRows.map((virtualRow) => {
            const row = rowModel.rows.at(virtualRow.index);
            if (!row) {
              return null;
            }

            return (
              <DraggableRow
                activeEntityId={activeEntityId}
                activeTaskId={activeTaskId}
                editingEntityId={editingEntityId}
                index={virtualRow.index}
                key={row.id}
                lastSelectedIndex={lastSelectedIndex}
                onAddColumn={openAddColumn}
                onRename={(entityId, newName) => {
                  renameEntity.mutate({
                    workspaceId,
                    entityId,
                    name: newName,
                  });
                }}
                onStartEditing={setEditingEntityId}
                onStopEditing={() => setEditingEntityId(null)}
                row={row}
                rowLabel={rowLabels[virtualRow.index] ?? ""}
                table={table}
                workspaceId={workspaceId}
              />
            );
          })}
          {paddingBottom > 0 && (
            <TableRow aria-hidden="true">
              <TableCell
                colSpan={visibleColumnCount}
                style={{ height: paddingBottom, padding: 0 }}
              />
            </TableRow>
          )}
          <BottomRow
            onFolderCreated={setEditingEntityId}
            table={table}
            workspaceId={workspaceId}
          />
        </TableBody>
      </Table>
      <CreateProperty
        onOpenChange={setAddColumnOpen}
        open={addColumnOpen}
        triggerVariant="none"
        workspaceId={workspaceId}
      />
    </div>
  );
};

// -- Draggable table row --

type DraggableRowProps = {
  row: Row<TableTreeNode>;
  index: number;
  rowLabel: string;
  table: WorkspaceTableType;
  workspaceId: string;
  activeEntityId: string | null;
  activeTaskId: string | null;
  editingEntityId: string | null;
  lastSelectedIndex: React.RefObject<number | null>;
  onAddColumn: () => void;
  onRename: (entityId: string, newName: string) => void;
  onStartEditing: (entityId: string) => void;
  onStopEditing: () => void;
};

const DraggableRow = ({
  row,
  index,
  rowLabel,
  table,
  workspaceId,
  activeEntityId,
  activeTaskId,
  editingEntityId,
  lastSelectedIndex,
  onAddColumn,
  onRename,
  onStartEditing,
  onStopEditing,
}: DraggableRowProps) => {
  const rowRef = useRef<HTMLTableRowElement>(null);
  const bulkEntitiesRef = useRef<TableTreeNode[] | undefined>(undefined);
  const [contextOpen, setContextOpen] = useState(false);
  const [contextAnchor, setContextAnchor] = useState<VirtualAnchor | null>(
    null,
  );
  const entity = row.original;

  useInspectorFlash(entity.entityId, rowRef);
  const isFolder = entity.kind === "folder";
  const isTask = entity.kind === "task";
  const visibleCells = row.getVisibleCells();
  const name = getEntityName(entity);
  const file = getFirstFile(entity);

  const getBulkSelectedEntities = () => {
    const selectedRows = table.getSelectedRowModel().rows;
    if (!row.getIsSelected() || selectedRows.length <= 1) {
      return undefined;
    }
    return selectedRows.map((selectedRow) => selectedRow.original);
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    bulkEntitiesRef.current = getBulkSelectedEntities();
    setContextAnchor({
      getBoundingClientRect: () => new DOMRect(e.clientX, e.clientY, 0, 0),
    });
    setContextOpen(true);
  };

  const selectCellContent = (
    <SelectRowContent
      index={index}
      label={rowLabel}
      lastSelectedIndex={lastSelectedIndex}
      row={row}
      table={table}
    />
  );

  const rowActions = (
    <RowActions
      anchor={contextAnchor}
      entity={entity}
      onOpenChange={(open) => {
        if (open) {
          bulkEntitiesRef.current = getBulkSelectedEntities();
        }
        setContextOpen(open);
        if (!open) {
          setContextAnchor(null);
          bulkEntitiesRef.current = undefined;
        }
      }}
      onRename={isFolder ? () => onStartEditing(entity.entityId) : undefined}
      open={contextOpen}
      selectedEntities={contextOpen ? bulkEntitiesRef.current : undefined}
      triggerClassName="opacity-0! transition-opacity group-hover/row:opacity-100! focus-visible:opacity-100!"
      workspaceId={workspaceId}
    />
  );

  // Kebab stays mounted (right-click context menu uses the same Menu),
  // but the visible trigger is hidden so the row checkbox owns this
  // slot. We use sr-only positioning rather than `display: none` so
  // keyboard users can still Tab to it and open the actions menu.
  const selectCellWithActions = (
    <>
      {selectCellContent}
      <span className="sr-only">{rowActions}</span>
    </>
  );

  useEffect(() => {
    const el = rowRef.current;
    if (!el) {
      return undefined;
    }

    return draggable({
      element: el,
      getInitialData: () => ({
        type: ENTITY_DRAG_TYPE,
        entityId: entity.entityId,
        entityIds: [entity.entityId],
        entities: [
          {
            entityId: entity.entityId,
            name,
            kind: entity.kind,
            mimeType: file?.mimeType ?? null,
            parentId: entity.parentId ?? null,
          },
        ],
      }),
      onGenerateDragPreview: ({ nativeSetDragImage }) => {
        setCustomNativeDragPreview({
          nativeSetDragImage,
          render: ({ container }) =>
            renderDragPreview(container, {
              name,
              kind: entity.kind,
              mimeType: file?.mimeType ?? null,
            }),
        });
      },
    });
  }, [entity.entityId, entity.kind, entity.parentId, name, file?.mimeType]);

  if (isFolder && visibleCells.length > 2) {
    const selectCell = visibleCells[0];
    const nameCell = visibleCells[1];
    if (!selectCell || !nameCell) {
      return null;
    }
    const remainingCount = visibleCells.length - 2;

    return (
      <TableRow
        data-active={entity.entityId === activeEntityId || undefined}
        data-state={row.getIsSelected() ? "selected" : undefined}
        key={row.id}
        onContextMenu={handleContextMenu}
        ref={rowRef}
      >
        <TableCell
          data-state={row.getIsSelected() ? "selected" : undefined}
          key={selectCell.id}
          style={{
            ...getPinningStyles(selectCell.column),
          }}
        >
          {selectCellWithActions}
        </TableCell>
        <TableCell
          className="cursor-pointer"
          data-state={row.getIsSelected() ? "selected" : undefined}
          key={nameCell.id}
          onClick={() => row.toggleExpanded()}
          style={{
            ...getPinningStyles(nameCell.column),
          }}
        >
          <FolderCell
            depth={row.depth}
            editingEntityId={editingEntityId}
            entity={entity}
            isExpanded={row.getIsExpanded()}
            onRename={onRename}
            onStopEditing={onStopEditing}
            startEditing={() => onStartEditing(entity.entityId)}
          />
        </TableCell>
        {remainingCount > 0 && (
          <TableCell
            className="cursor-pointer"
            colSpan={remainingCount}
            data-state={row.getIsSelected() ? "selected" : undefined}
            onClick={() => row.toggleExpanded()}
          />
        )}
      </TableRow>
    );
  }

  return (
    <TableRow
      className={cn(isTask && "cursor-pointer")}
      data-active={
        entity.entityId === activeEntityId ||
        entity.entityId === activeTaskId ||
        undefined
      }
      data-state={row.getIsSelected() ? "selected" : undefined}
      key={row.id}
      onClick={
        isTask
          ? () => useInspectorStore.getState().openTask(entity.entityId, name)
          : undefined
      }
      onContextMenu={handleContextMenu}
      ref={rowRef}
    >
      {visibleCells.map((cell) => {
        const isAddPropertyCell = cell.column.id === addPropertyColId;
        return (
          <TableCell
            className={cn(
              "relative",
              cell.column.id === selectColId && "min-w-12 shrink-0",
              cell.column.columnDef.meta?.muted && "text-muted-foreground",
              cell.column.getIsResizing() &&
                "after:bg-info after:pointer-events-none after:absolute after:top-0 after:right-0 after:bottom-0 after:z-50 after:w-px",
              // The "+" column has no per-row data; rendering its
              // body cells with the table's standard border made
              // them look clickable. Strip the border + background
              // so the column visually disappears below the header
              // and only the header itself reads as the action.
              isAddPropertyCell &&
                "border-e-0! border-b-0! bg-transparent! p-0",
            )}
            {...(isAddPropertyCell ? { "data-add-col": "" } : {})}
            data-state={cell.row.getIsSelected() ? "selected" : undefined}
            key={cell.id}
            style={{
              ...getPinningStyles(cell.column),
            }}
          >
            {cell.column.id === selectColId ? (
              selectCellWithActions
            ) : isAddPropertyCell ? (
              // Transparent click target so the entire "+" column —
              // header AND every body cell — opens the same dialog.
              // No visible affordance: the column is intentionally
              // blank below the header so users still read the
              // header as the trigger.
              <button
                aria-hidden
                // The column-wide highlight is driven by the
                // table-level `:has([data-add-cell]:hover)` rule
                // above, so this button just needs to be a click
                // surface; no per-element hover bg.
                className="absolute inset-0 cursor-pointer"
                data-add-cell
                onClick={onAddColumn}
                tabIndex={-1}
                type="button"
              />
            ) : (
              <span className="flex w-full min-w-0 items-center gap-1.5">
                {flexRender(cell.column.columnDef.cell, cell.getContext())}
              </span>
            )}
          </TableCell>
        );
      })}
    </TableRow>
  );
};

// -- Select row content --

type SelectRowContentProps = {
  index: number;
  label: string;
  row: Row<TableTreeNode>;
  table: ReactTable<TableTreeNode>;
  lastSelectedIndex: React.RefObject<number | null>;
};

const SelectRowContent = ({
  index,
  label,
  row,
  table,
  lastSelectedIndex,
}: SelectRowContentProps) => {
  const isFolder = row.original.kind === "folder";
  const someSelected =
    isFolder && row.subRows.length > 0 && row.getIsSomeSelected();

  const handleChange = (_checked: boolean, eventDetails: { event: Event }) => {
    if (
      eventDetails.event instanceof PointerEvent &&
      eventDetails.event.shiftKey &&
      lastSelectedIndex.current !== null
    ) {
      const start = Math.min(lastSelectedIndex.current, index);
      const end = Math.max(lastSelectedIndex.current, index);
      const rows = table.getRowModel().rows;
      const patch: Record<string, boolean> = {};
      for (let i = start; i <= end; i++) {
        const r = rows[i];
        if (r) {
          patch[r.id] = true;
        }
      }
      table.setRowSelection((prev) => ({
        ...prev,
        ...patch,
      }));
    } else {
      row.toggleSelected();
    }
    lastSelectedIndex.current = index;
  };

  return (
    <div className="absolute inset-0 flex min-w-12 shrink-0 items-center justify-center">
      <span className="absolute inset-0 flex min-w-12 shrink-0 items-center justify-center text-xs tabular-nums transition-opacity group-hover/row:opacity-0 group-data-[state=selected]/row:opacity-0">
        {label}
      </span>
      <Checkbox
        checked={row.getIsSelected()}
        className="pointer-events-none absolute shrink-0 opacity-0 transition-opacity group-hover/row:pointer-events-auto group-hover/row:opacity-100 group-data-[state=selected]/row:pointer-events-auto group-data-[state=selected]/row:opacity-100"
        indeterminate={someSelected}
        onCheckedChange={handleChange}
        tabIndex={row.getIsSelected() ? 0 : -1}
      />
    </div>
  );
};

// -- Folder cell --

type FolderCellProps = {
  entity: TableTreeNode;
  depth: number;
  isExpanded: boolean;
  editingEntityId: string | null;
  startEditing: () => void;
  onStopEditing: () => void;
  onRename: (entityId: string, newName: string) => void;
};

const FolderCell = ({
  entity,
  depth,
  isExpanded,
  editingEntityId,
  startEditing,
  onStopEditing,
  onRename,
}: FolderCellProps) => {
  const name = getEntityName(entity);
  const isEditing = editingEntityId === entity.entityId;
  const [editValue, setEditValue] = useState(name);

  const commitRename = () => {
    onStopEditing();
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== name) {
      onRename(entity.entityId, trimmed);
    }
  };

  return (
    <div
      className="flex w-full items-center gap-1"
      style={{
        paddingLeft: depth > 0 ? `${depth * 20}px` : undefined,
      }}
    >
      <button className="flex shrink-0 items-center" type="button">
        <ChevronRightIcon
          className={cn(
            "size-3.5 transition-transform",
            isExpanded && "rotate-90",
          )}
        />
      </button>
      {isExpanded ? (
        <FolderOpenIcon className="text-muted-foreground size-4 shrink-0" />
      ) : (
        <FolderIcon className="text-muted-foreground size-4 shrink-0" />
      )}
      {isEditing ? (
        <InlineEdit
          inputClassName="w-48"
          onCancel={() => {
            onStopEditing();
            setEditValue(name);
          }}
          onChange={setEditValue}
          onCommit={commitRename}
          value={editValue}
        />
      ) : (
        <button
          className="truncate text-start text-sm"
          onDoubleClick={(e) => {
            e.stopPropagation();
            setEditValue(name);
            startEditing();
          }}
          type="button"
        >
          {name}
        </button>
      )}
    </div>
  );
};
