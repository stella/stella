import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";

import { draggable } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { setCustomNativeDragPreview } from "@atlaskit/pragmatic-drag-and-drop/element/set-custom-native-drag-preview";
import { flexRender } from "@tanstack/react-table";
import type {
  Cell,
  Column,
  Table as ReactTable,
  Row,
} from "@tanstack/react-table";
import { ChevronRightIcon, FolderIcon, FolderOpenIcon } from "lucide-react";

import { Checkbox } from "@stll/ui/components/checkbox";
import { containedHandler } from "@stll/ui/hooks/use-contained-handler";
import { cn } from "@stll/ui/lib/utils";

import { renderDragPreview } from "@/components/drag-preview";
import { TOOLBAR_ROW_HEIGHT } from "@/lib/consts";
import { ENTITY_DRAG_TYPE } from "@/routes/_protected.workspaces/$workspaceId/-components/drag-constants";
import { InlineEdit } from "@/routes/_protected.workspaces/$workspaceId/-components/inline-edit";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import { RowActions } from "@/routes/_protected.workspaces/$workspaceId/-components/row-actions";
import type { VirtualAnchor } from "@/routes/_protected.workspaces/$workspaceId/-components/row-actions";
import type {
  TableTreeNode,
  WorkspaceTable as WorkspaceTableType,
} from "@/routes/_protected.workspaces/$workspaceId/-components/table/types";
import {
  WorkspaceGridCell,
  WorkspaceGridRow,
} from "@/routes/_protected.workspaces/$workspaceId/-components/table/workspace-grid";
import { getOrderedCells } from "@/routes/_protected.workspaces/$workspaceId/-components/table/workspace-grid-order";
import {
  AddPropertyCell,
  RowEndFillerCell,
} from "@/routes/_protected.workspaces/$workspaceId/-components/table/workspace-table/end-fillers";
import {
  addPropertyColId,
  getGridPinningStyles,
  isPinnedBoundaryColumn,
  PinnedBoundary,
  selectColId,
} from "@/routes/_protected.workspaces/$workspaceId/-components/table/workspace-table/internals";
import { VersionOrNewFileDialog } from "@/routes/_protected.workspaces/$workspaceId/-components/version-or-new-file-dialog";
import type { TableContentMode } from "@/routes/_protected.workspaces/$workspaceId/-hooks/table-store";
import { useCreateFileEntities } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-create-file-entities";
import { useExternalFileDrop } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-external-file-drop";
import { useInspectorFlash } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-inspector-flash";
import { useUploadVersion } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-upload-version";
import {
  getEntityName,
  getFirstFile,
} from "@/routes/_protected.workspaces/$workspaceId/-utils";

const shouldIgnoreRowExpansionClick = (target: EventTarget) => {
  if (!(target instanceof HTMLElement)) {
    return true;
  }

  if (target.closest("[data-open-expanded-cell]")) {
    return false;
  }

  return Boolean(
    target.closest(
      "button, a, input, textarea, select, [role='button'], [role='checkbox'], [data-row-expansion-ignore], [data-slot='select-trigger']",
    ),
  );
};

const getContextPropertyId = (target: EventTarget) => {
  if (!(target instanceof HTMLElement)) {
    return null;
  }

  return (
    target.closest<HTMLElement>("[data-table-property-id]")?.dataset[
      "tablePropertyId"
    ] ?? null
  );
};

type ActiveCellFlashInput = {
  activeCellPropertyId: string | null;
  activationSeq: number;
  rowRef: React.RefObject<HTMLDivElement | null>;
  visibleCells: Cell<TableTreeNode, unknown>[];
};

const useActiveCellFlash = ({
  activeCellPropertyId,
  activationSeq,
  rowRef,
  visibleCells,
}: ActiveCellFlashInput) => {
  const previousCellActivationSeq = useRef(activationSeq);

  useEffect(() => {
    const rowElement = rowRef.current;
    if (
      !rowElement ||
      !activeCellPropertyId ||
      activationSeq === previousCellActivationSeq.current
    ) {
      previousCellActivationSeq.current = activationSeq;
      return;
    }

    const cellIndex = visibleCells.findIndex(
      (cell) => cell.column.id === activeCellPropertyId,
    );
    const cellElement = rowElement.children.item(cellIndex);
    if (!(cellElement instanceof HTMLElement)) {
      previousCellActivationSeq.current = activationSeq;
      return;
    }

    cellElement.scrollIntoView({ block: "nearest", behavior: "smooth" });
    const c = "var(--color-primary)";
    const t = "transparent";
    cellElement.animate(
      [
        { boxShadow: `inset 0 0 0 2px ${c}` },
        { boxShadow: `inset 0 0 0 2px ${t}` },
      ],
      { duration: 500, easing: "ease-out" },
    );
    previousCellActivationSeq.current = activationSeq;
  }, [activationSeq, activeCellPropertyId, rowRef, visibleCells]);
};

type ActiveRowInput = {
  activeCellPropertyId: string | null;
  activeEntityId: string | null;
  activeTaskId: string | null;
  entityId: string;
};

const isActiveRow = ({
  activeCellPropertyId,
  activeEntityId,
  activeTaskId,
  entityId,
}: ActiveRowInput) =>
  entityId === activeTaskId ||
  (entityId === activeEntityId && activeCellPropertyId === null);

// -- Draggable table row --

export type DraggableRowProps = {
  row: Row<TableTreeNode>;
  virtualIndex: number;
  index: number;
  rowLabel: string;
  renderColumns: Column<TableTreeNode>[];
  addPropertyColumn: Column<TableTreeNode> | null;
  table: WorkspaceTableType;
  workspaceId: string;
  activeEntityId: string | null;
  activePropertyId: string | null;
  activeTaskId: string | null;
  contentMode: TableContentMode;
  editingEntityId: string | null;
  expandedCellId: string | null;
  hasExpandedTableCell: boolean;
  lastSelectedIndex: React.RefObject<number | null>;
  measureElement: (element: Element | null) => void;
  onRename: (entityId: string, newName: string) => void;
  onStartEditing: (entityId: string) => void;
  onStopEditing: () => void;
  onToggleExpandedCell: (
    entityId: string,
    columnId: string,
    mode?: "toggle" | "open",
  ) => void;
};

export const DraggableRow = ({
  row,
  virtualIndex,
  index,
  rowLabel,
  renderColumns,
  addPropertyColumn,
  table,
  workspaceId,
  activeEntityId,
  activePropertyId,
  activeTaskId,
  contentMode,
  editingEntityId,
  expandedCellId,
  hasExpandedTableCell,
  lastSelectedIndex,
  measureElement,
  onRename,
  onStartEditing,
  onStopEditing,
  onToggleExpandedCell,
}: DraggableRowProps) => {
  const rowRef = useRef<HTMLDivElement>(null);
  const setRowRef = useCallback(
    (element: HTMLDivElement | null) => {
      rowRef.current = element;
      measureElement(element);
    },
    [measureElement],
  );
  const bulkEntitiesRef = useRef<TableTreeNode[] | undefined>(undefined);
  const [contextOpen, setContextOpen] = useState(false);
  const [contextAnchor, setContextAnchor] = useState<VirtualAnchor | null>(
    null,
  );
  const [contextPropertyId, setContextPropertyId] = useState<string | null>(
    null,
  );
  // State for version-or-new-file dialog
  const [versionDialogFile, setVersionDialogFile] = useState<File | null>(null);
  const uploadVersion = useUploadVersion();
  const [, createFileEntities] = useCreateFileEntities(workspaceId);

  const entity = row.original;
  const isFolder = entity.kind === "folder";
  const isTask = entity.kind === "task";
  const isFocusedExpansionRow = expandedCellId !== null;
  const isMutedByExpandedCell = hasExpandedTableCell && !isFocusedExpansionRow;
  const visibleCells = getOrderedCells(row.getVisibleCells(), renderColumns);
  const addPropertyCell = addPropertyColumn
    ? row
        .getVisibleCells()
        .find((cell) => cell.column.id === addPropertyColumn.id)
    : undefined;
  const name = getEntityName(entity);
  const file = getFirstFile(entity);
  const activeCellPropertyId =
    entity.entityId === activeEntityId ? activePropertyId : null;
  const activeRow = isActiveRow({
    activeCellPropertyId,
    activeEntityId,
    activeTaskId,
    entityId: entity.entityId,
  });
  const activationSeq = useInspectorStore((s) => s.activationSeq);

  useInspectorFlash(entity.entityId, rowRef, {
    enabled: activeCellPropertyId === null,
  });
  useActiveCellFlash({
    activeCellPropertyId,
    activationSeq,
    rowRef,
    visibleCells,
  });

  // Handle file drops on document rows (non-folder, non-task)
  const handleFileDrop = useCallback(
    (files: File[]) => {
      // Multi-file drop or folder: create new files
      if (files.length > 1 || isFolder) {
        createFileEntities(files);
        return;
      }

      // Single file drop on document row: show dialog
      const droppedFile = files[0];
      if (droppedFile && file) {
        setVersionDialogFile(droppedFile);
      } else {
        // Entity has no file (shouldn't happen for file entities), just create new
        createFileEntities(files);
      }
    },
    [createFileEntities, file, isFolder],
  );

  // Only enable drop target for file entities (not folders, not tasks)
  const canAcceptDrop = !isFolder && !isTask && file !== null;
  const { isDropTarget } = useExternalFileDrop({
    id: entity.entityId,
    onDrop: handleFileDrop,
    enabled: canAcceptDrop,
    externalRef: rowRef,
  });

  const handleReplaceVersion = () => {
    if (!versionDialogFile || !file) {
      return;
    }
    uploadVersion.mutate(
      {
        workspaceId,
        entityId: entity.entityId,
        entityFileName: file.fileName,
        file: versionDialogFile,
      },
      {
        onSettled: () => setVersionDialogFile(null),
      },
    );
  };

  const handleCreateNewFile = () => {
    if (!versionDialogFile) {
      return;
    }
    createFileEntities([versionDialogFile]);
    setVersionDialogFile(null);
  };

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
    setContextPropertyId(getContextPropertyId(e.target));
    setContextAnchor({
      getBoundingClientRect: () => new DOMRect(e.clientX, e.clientY, 0, 0),
    });
    // Defer to the next frame so the trailing pointerup from the
    // right-click doesn't immediately count as an outside-click and
    // dismiss the menu that the contextmenu just opened.
    requestAnimationFrame(() => setContextOpen(true));
  };

  const handleRowClick = (e: React.MouseEvent) => {
    if (!isTask || shouldIgnoreRowExpansionClick(e.target)) {
      return;
    }

    useInspectorStore.getState().openTask(entity.entityId, name);
  };

  const toggleExpandedCell = (columnId: string, mode?: "toggle" | "open") => {
    onToggleExpandedCell(entity.entityId, columnId, mode);
  };

  const handleCellClick = (
    event: React.MouseEvent,
    columnId: string,
    canExpandCell: boolean,
  ) => {
    if (!canExpandCell || shouldIgnoreRowExpansionClick(event.target)) {
      return;
    }

    event.stopPropagation();
    toggleExpandedCell(
      columnId,
      event.target instanceof Element &&
        event.target.closest("[data-open-expanded-cell]")
        ? "open"
        : "toggle",
    );
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
          setContextPropertyId(null);
          bulkEntitiesRef.current = undefined;
        }
      }}
      onRename={isFolder ? () => onStartEditing(entity.entityId) : undefined}
      open={contextOpen}
      selectedEntities={contextOpen ? bulkEntitiesRef.current : undefined}
      cellMetadataTarget={
        contextPropertyId
          ? {
              propertyId: contextPropertyId,
              metadata: entity.cellMetadata[contextPropertyId],
            }
          : null
      }
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
    if (rowRef.current) {
      measureElement(rowRef.current);
    }
  }, [contentMode, expandedCellId, measureElement]);

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
    return (
      <FolderTableRow
        activeEntityId={activeEntityId}
        addPropertyCell={addPropertyCell}
        editingEntityId={editingEntityId}
        entity={entity}
        isMutedByExpandedCell={isMutedByExpandedCell}
        onContextMenu={handleContextMenu}
        onRename={onRename}
        onStartEditing={onStartEditing}
        onStopEditing={onStopEditing}
        ref={setRowRef}
        renderColumns={renderColumns}
        row={row}
        selectCellWithActions={selectCellWithActions}
        virtualIndex={virtualIndex}
        visibleCells={visibleCells}
      />
    );
  }

  return (
    <>
      <WorkspaceGridRow
        aria-rowindex={virtualIndex + 2}
        aria-selected={row.getIsSelected()}
        className={cn(
          "transition-opacity duration-150",
          contentMode === "tight" && TOOLBAR_ROW_HEIGHT,
          isTask && "cursor-pointer",
          isFocusedExpansionRow && "z-20",
          isMutedByExpandedCell && "opacity-[0.92] hover:opacity-100",
          // Cells render their own backgrounds on top of the row, so
          // the drop-target outline lives in a pseudo-element above
          // the cells. Cell tint is handled by WorkspaceGridCell's
          // `group-data-[drop-target]/row:` selector.
          isDropTarget &&
            "after:pointer-events-none after:absolute after:inset-0 after:z-10 after:shadow-[inset_0_0_0_2px_var(--color-primary)] after:content-['']",
        )}
        data-active={activeRow || undefined}
        data-drop-target={isDropTarget || undefined}
        data-index={virtualIndex}
        data-state={row.getIsSelected() ? "selected" : undefined}
        key={row.id}
        onClick={containedHandler(rowRef, handleRowClick)}
        onContextMenu={handleContextMenu}
        ref={setRowRef}
      >
        <DataRowCells
          expandedCellId={expandedCellId}
          contentMode={contentMode}
          hasExpandedCell={isFocusedExpansionRow}
          onCellClick={handleCellClick}
          selectCellWithActions={selectCellWithActions}
          visibleCells={visibleCells}
        />
        <RowEndFillerCell
          addPropertyColumn={addPropertyColumn}
          renderColumns={renderColumns}
          selected={row.getIsSelected()}
        />
        <AddPropertyCell
          cell={addPropertyCell}
          columnIndex={renderColumns.length + 1}
          selected={row.getIsSelected()}
        />
      </WorkspaceGridRow>
      {versionDialogFile && (
        <VersionOrNewFileDialog
          droppedFile={versionDialogFile}
          entityFileName={file?.fileName}
          isCreatePending={false}
          isReplacePending={uploadVersion.isPending}
          onCreateNewFile={handleCreateNewFile}
          onOpenChange={(open) => {
            if (!open) {
              setVersionDialogFile(null);
            }
          }}
          onReplaceVersion={handleReplaceVersion}
          open
        />
      )}
    </>
  );
};

type FolderTableRowProps = {
  activeEntityId: string | null;
  addPropertyCell: Cell<TableTreeNode, unknown> | undefined;
  editingEntityId: string | null;
  entity: TableTreeNode;
  isMutedByExpandedCell: boolean;
  onContextMenu: (event: React.MouseEvent) => void;
  onRename: (entityId: string, newName: string) => void;
  onStartEditing: (entityId: string) => void;
  onStopEditing: () => void;
  ref: (element: HTMLDivElement | null) => void;
  renderColumns: Column<TableTreeNode>[];
  row: Row<TableTreeNode>;
  selectCellWithActions: React.ReactNode;
  virtualIndex: number;
  visibleCells: Cell<TableTreeNode, unknown>[];
};

const FolderTableRow = ({
  activeEntityId,
  addPropertyCell,
  editingEntityId,
  entity,
  isMutedByExpandedCell,
  onContextMenu,
  onRename,
  onStartEditing,
  onStopEditing,
  ref,
  renderColumns,
  row,
  selectCellWithActions,
  virtualIndex,
  visibleCells,
}: FolderTableRowProps) => {
  const selectCell = visibleCells[0];
  const nameCell = visibleCells[1];
  if (!selectCell || !nameCell) {
    return null;
  }

  return (
    <WorkspaceGridRow
      aria-rowindex={virtualIndex + 2}
      aria-selected={row.getIsSelected()}
      className={cn(
        "transition-opacity duration-150",
        TOOLBAR_ROW_HEIGHT,
        isMutedByExpandedCell && "opacity-[0.92] hover:opacity-100",
      )}
      data-active={entity.entityId === activeEntityId || undefined}
      data-index={virtualIndex}
      data-state={row.getIsSelected() ? "selected" : undefined}
      key={row.id}
      onContextMenu={onContextMenu}
      ref={ref}
    >
      <WorkspaceGridCell
        aria-colindex={1}
        className={cn(
          isPinnedBoundaryColumn(selectCell.column) && "border-e-0",
        )}
        data-state={row.getIsSelected() ? "selected" : undefined}
        key={selectCell.id}
        style={{
          gridColumn: 1,
          ...getGridPinningStyles(selectCell.column),
        }}
      >
        <PinnedBoundary column={selectCell.column} />
        {selectCellWithActions}
      </WorkspaceGridCell>
      <WorkspaceGridCell
        aria-colindex={2}
        className={cn(
          "cursor-pointer",
          isPinnedBoundaryColumn(nameCell.column) && "border-e-0",
        )}
        data-state={row.getIsSelected() ? "selected" : undefined}
        key={nameCell.id}
        onClick={() => row.toggleExpanded()}
        style={{
          gridColumn: 2,
          ...getGridPinningStyles(nameCell.column),
        }}
      >
        <PinnedBoundary column={nameCell.column} />
        <FolderCell
          depth={row.depth}
          editingEntityId={editingEntityId}
          entity={entity}
          isExpanded={row.getIsExpanded()}
          onRename={onRename}
          onStopEditing={onStopEditing}
          startEditing={() => onStartEditing(entity.entityId)}
        />
      </WorkspaceGridCell>
      <WorkspaceGridCell
        aria-colindex={3}
        className="cursor-pointer border-e-0"
        data-state={row.getIsSelected() ? "selected" : undefined}
        onClick={() => row.toggleExpanded()}
        style={{ gridColumn: addPropertyCell ? "3 / -2" : "3 / -1" }}
      />
      <AddPropertyCell
        cell={addPropertyCell}
        columnIndex={renderColumns.length + 1}
        selected={row.getIsSelected()}
      />
    </WorkspaceGridRow>
  );
};

type DataRowCellsProps = {
  expandedCellId: string | null;
  contentMode: TableContentMode;
  hasExpandedCell: boolean;
  onCellClick: (
    event: React.MouseEvent,
    columnId: string,
    canExpandCell: boolean,
  ) => void;
  selectCellWithActions: React.ReactNode;
  visibleCells: Cell<TableTreeNode, unknown>[];
};

const DataRowCells = ({
  expandedCellId,
  contentMode,
  hasExpandedCell,
  onCellClick,
  selectCellWithActions,
  visibleCells,
}: DataRowCellsProps) =>
  visibleCells.map((cell, cellIndex) => {
    const isSelectCell = cell.column.id === selectColId;
    const isAddPropertyCell = cell.column.id === addPropertyColId;
    const canExpandCell = !isSelectCell && !isAddPropertyCell;
    const canFlagCell = canExpandCell && !cell.column.id.startsWith("_");
    const isExpandedCell = expandedCellId === cell.column.id;
    const fieldContent = cell.row.original.fields[cell.column.id]?.content;
    const isExpandedTextCell = isExpandedCell && fieldContent?.type === "text";

    return (
      <WorkspaceGridCell
        aria-colindex={cellIndex + 1}
        className={cn(
          "relative",
          canExpandCell && "cursor-pointer",
          isSelectCell && "min-w-12 shrink-0",
          isPinnedBoundaryColumn(cell.column) && "border-e-0",
          cell.column.columnDef.meta?.muted && "text-muted-foreground",
          contentMode === "fit-content" &&
            "whitespace-normal! [&_.line-clamp-2]:line-clamp-none [&_.truncate]:min-w-0 [&_.truncate]:overflow-visible [&_.truncate]:wrap-break-word [&_.truncate]:whitespace-normal",
          hasExpandedCell &&
            !isExpandedCell &&
            !isSelectCell &&
            "opacity-90 transition-opacity duration-150",
          isExpandedCell &&
            "z-30 overflow-visible! whitespace-normal! [&_.line-clamp-2]:line-clamp-none [&_.truncate]:min-w-0 [&_.truncate]:overflow-visible [&_.truncate]:wrap-break-word [&_.truncate]:whitespace-normal",
          cell.column.getIsResizing() &&
            "after:bg-info after:pointer-events-none after:absolute after:top-0 after:right-0 after:bottom-0 after:z-50 after:w-px",
        )}
        data-expanded-cell={isExpandedCell || undefined}
        data-state={cell.row.getIsSelected() ? "selected" : undefined}
        data-table-property-id={canFlagCell ? cell.column.id : undefined}
        key={cell.id}
        onClick={(event) => onCellClick(event, cell.column.id, canExpandCell)}
        style={{
          gridColumn: cellIndex + 1,
          ...getGridPinningStyles(cell.column),
        }}
      >
        <PinnedBoundary column={cell.column} />
        {isSelectCell ? (
          selectCellWithActions
        ) : (
          <span
            className={cn(
              "flex w-full min-w-0 items-center gap-1.5",
              (contentMode === "fit-content" || isExpandedTextCell) &&
                "items-start",
              isExpandedCell &&
                "border-border/80 bg-background absolute inset-x-0 top-0 z-40 max-h-96 min-h-24 items-start overflow-y-auto border p-2 pb-8 shadow-lg",
            )}
          >
            {flexRender(cell.column.columnDef.cell, cell.getContext())}
          </span>
        )}
      </WorkspaceGridCell>
    );
  });

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
