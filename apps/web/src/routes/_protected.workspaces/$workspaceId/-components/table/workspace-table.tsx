import { useEffect, useMemo, useRef, useState } from "react";

import { draggable } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { setCustomNativeDragPreview } from "@atlaskit/pragmatic-drag-and-drop/element/set-custom-native-drag-preview";
import { flexRender } from "@tanstack/react-table";
import type { Table as ReactTable, Row } from "@tanstack/react-table";
import { ChevronRightIcon, FolderIcon, FolderOpenIcon } from "lucide-react";

import { Checkbox } from "@stella/ui/components/checkbox";
import { cn } from "@stella/ui/lib/utils";

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
import { ENTITY_DRAG_TYPE } from "@/routes/_protected.workspaces/$workspaceId/-components/drag-constants";
import { InlineEdit } from "@/routes/_protected.workspaces/$workspaceId/-components/inline-edit";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
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

type WorkspaceTableProps = {
  workspaceId: string;
  table: WorkspaceTableType;
};

export const WorkspaceTable = ({ workspaceId, table }: WorkspaceTableProps) => {
  const tableWrapperRef = useRef<HTMLDivElement>(null);
  const lastSelectedIndex = useRef<number | null>(null);
  const [editingEntityId, setEditingEntityId] = useState<string | null>(null);

  const renameEntity = useRenameEntity();

  const activeEntityId = useInspectorStore((s) => {
    if (!s.activeId) {
      return null;
    }
    const tab = s.tabs.find((t) => t.id === s.activeId);
    return tab?.type === "pdf" ? tab.entityId : null;
  });

  const activeTaskId = useInspectorStore((s) => {
    if (!s.activeId) {
      return null;
    }
    const tab = s.tabs.find((t) => t.id === s.activeId);
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

  return (
    <div className="relative h-full flex-1 overflow-auto" ref={tableWrapperRef}>
      <Table
        className="[&_td]:border-border [&_th]:border-border table-auto border-separate border-spacing-0 [&_tfoot_td]:border-t [&_th]:border-b [&_tr]:border-none [&_tr:not(:nth-last-child(2))_td]:border-b"
        style={{
          width: "100%",
          minWidth: table.getTotalSize(),
        }}
      >
        <TableHeader className="bg-background sticky top-0 z-10 border-b">
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <TableHead
                  className="group/table-head bg-background hover:bg-background relative h-10 border-t px-0"
                  colSpan={header.colSpan}
                  key={header.id}
                  style={{
                    ...getPinningStyles(header.column),
                  }}
                >
                  {header.isPlaceholder
                    ? null
                    : flexRender(
                        header.column.columnDef.header,
                        header.getContext(),
                      )}
                  {header.column.getCanResize() && (
                    <button
                      className="user-select-none absolute top-0 -right-2 z-10 hidden h-full w-4 cursor-col-resize touch-none py-1 group-hover/table-head:flex"
                      onDoubleClick={() => header.column.resetSize()}
                      onMouseDown={header.getResizeHandler()}
                      onTouchStart={header.getResizeHandler()}
                      type="button"
                    >
                      <span className="bg-primary/25 mr-auto h-full w-1 rounded" />
                    </button>
                  )}
                  {header.column.getIsResizing() && (
                    <div
                      className="bg-info absolute top-0 right-0 z-10 w-px"
                      style={{
                        height: `${tableWrapperRef.current?.clientHeight ?? 0}px`,
                      }}
                    />
                  )}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {rowModel.rows.map((row, index) => (
            <DraggableRow
              activeEntityId={activeEntityId}
              activeTaskId={activeTaskId}
              editingEntityId={editingEntityId}
              index={index}
              key={row.id}
              lastSelectedIndex={lastSelectedIndex}
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
              rowLabel={rowLabels[index]}
              table={table}
            />
          ))}
          <BottomRow
            onFolderCreated={setEditingEntityId}
            table={table}
            workspaceId={workspaceId}
          />
        </TableBody>
      </Table>
    </div>
  );
};

// -- Draggable table row --

type DraggableRowProps = {
  row: Row<TableTreeNode>;
  index: number;
  rowLabel: string;
  table: WorkspaceTableType;
  activeEntityId: string | null;
  activeTaskId: string | null;
  editingEntityId: string | null;
  lastSelectedIndex: React.RefObject<number | null>;
  onRename: (entityId: string, newName: string) => void;
  onStartEditing: (entityId: string) => void;
  onStopEditing: () => void;
};

const DraggableRow = ({
  row,
  index,
  rowLabel,
  table,
  activeEntityId,
  activeTaskId,
  editingEntityId,
  lastSelectedIndex,
  onRename,
  onStartEditing,
  onStopEditing,
}: DraggableRowProps) => {
  const rowRef = useRef<HTMLTableRowElement>(null);
  const entity = row.original;

  useInspectorFlash(entity.entityId, rowRef);
  const isFolder = entity.kind === "folder";
  const isTask = entity.kind === "task";
  const visibleCells = row.getVisibleCells();
  const name = getEntityName(entity);
  const file = getFirstFile(entity);

  useEffect(() => {
    const el = rowRef.current;
    if (!el) {
      return;
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
    const remainingCount = visibleCells.length - 2;

    return (
      <TableRow
        data-active={entity.entityId === activeEntityId || undefined}
        data-state={row.getIsSelected() && "selected"}
        key={row.id}
        ref={rowRef}
      >
        <TableCell
          data-state={row.getIsSelected() ? "selected" : undefined}
          key={selectCell.id}
          style={{
            ...getPinningStyles(selectCell.column),
          }}
        >
          <SelectRowContent
            index={index}
            label={rowLabel}
            lastSelectedIndex={lastSelectedIndex}
            row={row}
            table={table}
          />
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
      data-state={row.getIsSelected() && "selected"}
      key={row.id}
      onClick={
        isTask
          ? () => useInspectorStore.getState().openTask(entity.entityId, name)
          : undefined
      }
      ref={rowRef}
    >
      {visibleCells.map((cell) => (
        <TableCell
          className={cn(
            cell.column.columnDef.meta?.muted && "text-muted-foreground",
          )}
          data-state={cell.row.getIsSelected() ? "selected" : undefined}
          key={cell.id}
          style={{
            ...getPinningStyles(cell.column),
          }}
        >
          {cell.column.id === selectColId ? (
            <SelectRowContent
              index={index}
              label={rowLabel}
              lastSelectedIndex={lastSelectedIndex}
              row={row}
              table={table}
            />
          ) : (
            flexRender(cell.column.columnDef.cell, cell.getContext())
          )}
        </TableCell>
      ))}
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
        patch[rows[i].id] = true;
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
    <div className="flex min-h-5 items-center justify-center">
      <span className="block text-xs tabular-nums group-hover/row:hidden group-data-[state=selected]/row:hidden">
        {label}
      </span>
      <Checkbox
        checked={row.getIsSelected()}
        className="hidden group-hover/row:block group-data-[state=selected]/row:block"
        indeterminate={someSelected}
        onCheckedChange={handleChange}
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
