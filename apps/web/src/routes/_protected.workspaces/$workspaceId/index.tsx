import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, retainSearchParams } from "@tanstack/react-router";
import {
  flexRender,
  getCoreRowModel,
  getExpandedRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type ExpandedState,
  type Table as ReactTable,
  type Row,
} from "@tanstack/react-table";
import {
  ChevronRightIcon,
  ClockIcon,
  FolderIcon,
  FolderOpenIcon,
  HashIcon,
  TableIcon,
  UserIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";
import { useShallow } from "zustand/shallow";

import { Checkbox } from "@stella/ui/components/checkbox";
import { toastManager } from "@stella/ui/components/toast";
import { cn } from "@stella/ui/lib/utils";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/table";
import type { WorkspaceView } from "@/lib/types";
import { BottomRow } from "@/routes/_protected.workspaces/$workspaceId/-components/bottom-row";
import { CreateProperty } from "@/routes/_protected.workspaces/$workspaceId/-components/create-property";
import { EmptyState } from "@/routes/_protected.workspaces/$workspaceId/-components/empty-state";
import { FilesystemView } from "@/routes/_protected.workspaces/$workspaceId/-components/filesystem/tree-view";
import { InlineEdit } from "@/routes/_protected.workspaces/$workspaceId/-components/inline-edit";
import { KanbanView } from "@/routes/_protected.workspaces/$workspaceId/-components/kanban/kanban-view";
import {
  AuthorCell,
  LastUpdatedCell,
  VersionCell,
} from "@/routes/_protected.workspaces/$workspaceId/-components/metadata-cells";
import { MetadataPopover } from "@/routes/_protected.workspaces/$workspaceId/-components/metadata-popover";
import { OverviewView } from "@/routes/_protected.workspaces/$workspaceId/-components/overview-view";
import { usePeekStore } from "@/routes/_protected.workspaces/$workspaceId/-components/peek/peek-store";
import { getPropertyColumn } from "@/routes/_protected.workspaces/$workspaceId/-components/table-column";
import { useTableState } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-table-state";
import {
  useCreateEntities,
  useMoveEntity,
  useRenameEntity,
} from "@/routes/_protected.workspaces/$workspaceId/-mutations/entities";
import { useUpdateView } from "@/routes/_protected.workspaces/$workspaceId/-mutations/views";
import { propertiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";
import { viewsOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/views";
import { useWorkspaceStore } from "@/routes/_protected.workspaces/$workspaceId/-store";
import {
  applyFilters,
  applySorts,
  buildTree,
  countDescendants,
  getEntityName,
  getInternalColId,
  getPinningStyles,
  sortProperty,
  type TreeNode,
} from "@/routes/_protected.workspaces/$workspaceId/-utils";

const ENTITY_DRAG_TYPE = "stella/entity-id";
const selectColId = getInternalColId("select");
const addPropertyColId = getInternalColId("add-property");
const metadataFieldIds = ["__created_by__", "__updated_at__", "__version__"];

export const Route = createFileRoute("/_protected/workspaces/$workspaceId/")({
  component: RouteComponent,
  search: {
    middlewares: [retainSearchParams(true)],
  },
});

export default function RouteComponent() {
  const workspaceId = Route.useParams({ select: (p) => p.workspaceId });
  const activeViewId = Route.useSearch({ select: (s) => s.view });

  const { data: views } = useSuspenseQuery(viewsOptions(workspaceId));
  const activeView = views.find((v) => v.id === activeViewId) ?? views[0];

  if (!activeView) {
    return null;
  }

  switch (activeView.layout) {
    case "overview":
      return <OverviewView workspaceId={workspaceId} />;
    case "filesystem":
      return <FilesystemView view={activeView} workspaceId={workspaceId} />;
    case "kanban":
      return <KanbanView view={activeView} workspaceId={workspaceId} />;
    case "gallery":
    case "table":
      return <TableView activeView={activeView} workspaceId={workspaceId} />;
    default: {
      const _exhaustive: never = activeView.layout;
      return _exhaustive;
    }
  }
}

type TableViewProps = {
  workspaceId: string;
  activeView: WorkspaceView;
};

const TableView = ({ workspaceId, activeView }: TableViewProps) => {
  const t = useTranslations();
  const tableState = useTableState();
  const tableWrapperRef = useRef<HTMLDivElement>(null);
  const lastSelectedIndex = useRef<number | null>(null);
  const [expanded, setExpanded] = useState<ExpandedState>(true);
  const [editingEntityId, setEditingEntityId] = useState<string | null>(null);
  const renameEntity = useRenameEntity();
  const moveEntity = useMoveEntity();
  const createEntities = useCreateEntities();
  const setEntityName = useWorkspaceStore((s) => s.setEntityName);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);

  const { data: properties } = useSuspenseQuery(propertiesOptions(workspaceId));
  const rawData = useWorkspaceStore(useShallow((s) => s.data));
  const updateView = useUpdateView();
  const activeEntityId = usePeekStore((s) => {
    if (!s.activeFieldId) {
      return null;
    }
    const tab = s.tabs.find((tab) => tab.fieldId === s.activeFieldId);
    return tab?.entityId ?? null;
  });

  const { filters, sorts, visibleProperties } = activeView.config;

  const hideColumn = useCallback(
    (columnId: string) => {
      const allVisible = visibleProperties.length === 0;
      const next = allVisible
        ? [...metadataFieldIds, ...properties.map((p) => p.id)].filter(
            (id) => id !== columnId,
          )
        : visibleProperties.filter((id) => id !== columnId);

      updateView.mutate({
        workspaceId,
        viewId: activeView.id,
        layout: activeView.layout,
        config: {
          ...activeView.config,
          visibleProperties: next.length === 0 ? [] : next,
        },
      });
    },
    [visibleProperties, properties, workspaceId, activeView, updateView],
  );

  const data = useMemo(() => {
    const filtered = applyFilters(rawData, filters);
    return applySorts(filtered, sorts);
  }, [rawData, filters, sorts]);

  const hasFolders = data.some((e) => e.kind === "folder");

  const allExpanded = expanded === true;
  const setFolderState = useWorkspaceStore((s) => s.setFolderState);
  const toggleVersion = useWorkspaceStore((s) => s.folderState.toggleVersion);

  useEffect(() => {
    setFolderState({ allExpanded, hasFolders });
  }, [allExpanded, hasFolders, setFolderState]);

  useEffect(() => {
    if (toggleVersion === 0) {
      return;
    }
    setExpanded((prev) => (prev === true ? {} : true));
  }, [toggleVersion]);

  const treeData = useMemo<TreeNode[]>(() => {
    if (!hasFolders) {
      return data.map((e) => ({ ...e, children: [] }));
    }
    return buildTree(data);
  }, [data, hasFolders]);

  const columns = useMemo(() => {
    const cols: ColumnDef<TreeNode>[] = [
      {
        id: selectColId,
        accessorKey: selectColId,
        header: (props) => (
          <div className="flex items-center justify-center">
            <Checkbox
              checked={props.table.getIsAllRowsSelected()}
              indeterminate={props.table.getIsSomeRowsSelected()}
              onCheckedChange={(_, e) =>
                props.table.getToggleAllRowsSelectedHandler()(e.event)
              }
            />
          </div>
        ),
        enableResizing: false,
        enableSorting: false,
        size: 48,
      },
    ];

    const visibleProps =
      visibleProperties.length > 0
        ? properties.filter((p) => visibleProperties.includes(p.id))
        : properties;

    for (let i = 0; i < visibleProps.length; i++) {
      const property = visibleProps[i];
      // SAFETY: TreeNode extends WorkspaceEntity, so
      // ColumnDef<WorkspaceEntity> is structurally compatible.
      const col = getPropertyColumn(property, {
        onHide: () => hideColumn(property.id),
      }) as ColumnDef<TreeNode>;

      // Wrap the first column's cell to include folder hierarchy
      if (i === 0 && hasFolders) {
        const originalCell = col.cell;
        col.cell = (props) => {
          const row = props.row;
          const isFolder = row.original.kind === "folder";
          const depth = row.depth;

          if (!isFolder) {
            return typeof originalCell === "function"
              ? originalCell(props)
              : flexRender(originalCell, props);
          }

          return (
            <FolderCell
              depth={depth}
              editingEntityId={editingEntityId}
              entity={row.original}
              isExpanded={row.getIsExpanded()}
              onRename={(entityId, newName) => {
                setEntityName(entityId, newName);
                renameEntity.mutate({
                  workspaceId,
                  entityId,
                  name: newName,
                });
              }}
              onStopEditing={() => setEditingEntityId(null)}
              startEditing={() => setEditingEntityId(row.original.entityId)}
            />
          );
        };
      }

      cols.push(col);
    }

    // Metadata columns (Author, Last updated) when visible
    const allVisible = visibleProperties.length === 0;

    if (allVisible || visibleProperties.includes("__created_by__")) {
      cols.push({
        id: "__created_by__",
        accessorKey: "__created_by__",
        meta: { muted: true },
        header: (ctx) => (
          <MetadataPopover
            column={ctx.header.column}
            icon={UserIcon}
            label={t("workspaces.filesystem.author")}
            onHide={() => hideColumn("__created_by__")}
            sortHint="text"
          />
        ),
        cell: (props) => <AuthorCell entity={props.row.original} />,
        sortingFn: (a, b) =>
          (a.original.createdBy ?? "").localeCompare(
            b.original.createdBy ?? "",
          ),
        size: 160,
      });
    }

    if (allVisible || visibleProperties.includes("__updated_at__")) {
      cols.push({
        id: "__updated_at__",
        accessorKey: "__updated_at__",
        meta: { muted: true },
        header: (ctx) => (
          <MetadataPopover
            column={ctx.header.column}
            icon={ClockIcon}
            label={t("workspaces.filesystem.lastUpdated")}
            onHide={() => hideColumn("__updated_at__")}
            sortHint="date"
          />
        ),
        cell: (props) => <LastUpdatedCell entity={props.row.original} />,
        sortingFn: (a, b) => {
          const aDate = a.original.updatedAt ?? a.original.createdAt;
          const bDate = b.original.updatedAt ?? b.original.createdAt;
          return aDate.localeCompare(bDate);
        },
        size: 140,
      });
    }

    if (allVisible || visibleProperties.includes("__version__")) {
      cols.push({
        id: "__version__",
        accessorKey: "__version__",
        meta: { muted: true },
        header: (ctx) => (
          <MetadataPopover
            column={ctx.header.column}
            icon={HashIcon}
            label={t("workspaces.filesystem.version")}
            onHide={() => hideColumn("__version__")}
            sortHint="number"
          />
        ),
        cell: (props) => <VersionCell entity={props.row.original} />,
        sortingFn: (a, b) =>
          (a.original.version ?? 0) - (b.original.version ?? 0),
        size: 80,
      });
    }

    cols.push({
      id: addPropertyColId,
      accessorKey: addPropertyColId,
      header: () => <CreateProperty workspaceId={workspaceId} />,
      enableResizing: false,
      enablePinning: false,
      enableSorting: false,
      size: 48,
    });

    return cols;
  }, [
    properties,
    workspaceId,
    visibleProperties,
    editingEntityId,
    hasFolders,
    hideColumn,
    t,
    renameEntity.mutate,
    setEntityName,
  ]);

  const table = useReactTable({
    columnResizeMode: "onChange",
    sortingFns: {
      sortProperty,
    },
    data: treeData,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getExpandedRowModel: hasFolders ? getExpandedRowModel() : undefined,
    getSubRows: hasFolders ? (row) => row.children : undefined,
    enableSortingRemoval: false,
    enableSubRowSelection: true,
    getRowId: (row) => row.entityId,
    state: {
      ...tableState.state,
      expanded,
    },
    onExpandedChange: setExpanded,
    onRowSelectionChange: tableState.onRowSelectionChange,
    onColumnSizingChange: tableState.onColumnSizingChange,
    onSortingChange: tableState.onSortingChange,
    onColumnPinningChange: tableState.onColumnPinningChange,
  });

  // Compute logical row labels that account for collapsed folder children.
  // Each visible row gets a 1-based number; collapsed folders show a range.
  const rowModel = table.getRowModel();
  const rowLabels = useMemo(() => {
    const rows = rowModel.rows;
    const labels: string[] = [];
    let logicalPos = 1;

    for (const row of rows) {
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

  const handleRowDrop = useCallback(
    (e: React.DragEvent, target: TreeNode) => {
      e.preventDefault();
      setDropTargetId(null);
      const entityId = e.dataTransfer.getData(ENTITY_DRAG_TYPE);
      if (!entityId || entityId === target.entityId) {
        return;
      }

      const onError = () => {
        toastManager.add({
          title: t("errors.actionFailed"),
          type: "error",
        });
      };

      if (target.kind === "folder") {
        moveEntity.mutate(
          { workspaceId, entityId, parentId: target.entityId },
          { onError },
        );
      } else {
        createEntities.mutate(
          {
            workspaceId,
            type: "manual-input",
            kind: "folder",
            parentId: target.parentId ?? undefined,
            name: t("workspaces.newFolder"),
          },
          {
            onSuccess: (data) => {
              if (!data?.entityId) {
                return;
              }
              const folderId = data.entityId;
              moveEntity.mutate({
                workspaceId,
                entityId: target.entityId,
                parentId: folderId,
              });
              moveEntity.mutate({
                workspaceId,
                entityId,
                parentId: folderId,
              });
              setExpanded((prev) => {
                if (prev === true) {
                  return true;
                }
                return { ...prev, [folderId]: true };
              });
              setEditingEntityId(folderId);
            },
            onError,
          },
        );
      }
    },
    [workspaceId, moveEntity, createEntities, t],
  );

  if (table.getRowModel().rows.length === 0) {
    return (
      <EmptyState
        icon={TableIcon}
        message={t("workspaces.noItems")}
        workspaceId={workspaceId}
      />
    );
  }

  return (
    <div className="relative h-full flex-1 overflow-auto *:data-[slot=table-container]:max-h-96">
      <Table
        className="table-auto border-separate border-spacing-0 [&_td]:border-border [&_tfoot_td]:border-t [&_th]:border-b [&_th]:border-border [&_tr]:border-none [&_tr:not(:nth-last-child(2))_td]:border-b"
        style={{
          width: "100%",
          minWidth: table.getTotalSize(),
        }}
      >
        <TableHeader className="sticky top-0 z-10 border-b bg-background">
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <TableHead
                  className="group/table-head relative h-10 border-t bg-background px-0 hover:bg-background"
                  colSpan={header.colSpan}
                  key={header.id}
                  style={{ ...getPinningStyles(header.column) }}
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
                      <span className="mr-auto h-full w-1 rounded bg-primary/25" />
                    </button>
                  )}
                  {header.column.getIsResizing() && (
                    <div
                      className="absolute top-0 right-0 z-10 w-px bg-info"
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
          {table.getRowModel().rows.map((row, index) => {
            const isFolder = row.original.kind === "folder";
            const visibleCells = row.getVisibleCells();

            // Folder rows: render select + first column + colspan
            if (isFolder && visibleCells.length > 2) {
              const selectCell = visibleCells[0];
              const nameCell = visibleCells[1];
              const remainingCount = visibleCells.length - 2;

              return (
                <TableRow
                  className={cn(
                    row.original.entityId === activeEntityId && "bg-muted/50",
                    dropTargetId === row.original.entityId &&
                      "ring-2 ring-primary",
                  )}
                  data-state={row.getIsSelected() && "selected"}
                  draggable
                  key={row.id}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDropTargetId(row.original.entityId);
                  }}
                  onDragLeave={() => setDropTargetId(null)}
                  onDragStart={(e) =>
                    e.dataTransfer.setData(
                      ENTITY_DRAG_TYPE,
                      row.original.entityId,
                    )
                  }
                  onDrop={(e) => handleRowDrop(e, row.original)}
                >
                  <TableCell
                    data-state={row.getIsSelected() ? "selected" : undefined}
                    key={selectCell.id}
                    style={{ ...getPinningStyles(selectCell.column) }}
                  >
                    <SelectRowContent
                      index={index}
                      label={rowLabels[index]}
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
                    style={{ ...getPinningStyles(nameCell.column) }}
                  >
                    {flexRender(
                      nameCell.column.columnDef.cell,
                      nameCell.getContext(),
                    )}
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
                className={cn(
                  row.original.entityId === activeEntityId && "bg-muted/50",
                  dropTargetId === row.original.entityId &&
                    "ring-2 ring-primary",
                )}
                data-state={row.getIsSelected() && "selected"}
                draggable
                key={row.id}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDropTargetId(row.original.entityId);
                }}
                onDragLeave={() => setDropTargetId(null)}
                onDragStart={(e) =>
                  e.dataTransfer.setData(
                    ENTITY_DRAG_TYPE,
                    row.original.entityId,
                  )
                }
                onDrop={(e) => handleRowDrop(e, row.original)}
              >
                {visibleCells.map((cell) => {
                  return (
                    <TableCell
                      className={cn(
                        cell.column.columnDef.meta?.muted &&
                          "text-muted-foreground",
                      )}
                      data-state={
                        cell.row.getIsSelected() ? "selected" : undefined
                      }
                      key={cell.id}
                      style={{ ...getPinningStyles(cell.column) }}
                    >
                      {cell.column.id === selectColId ? (
                        <SelectRowContent
                          index={index}
                          label={rowLabels[index]}
                          lastSelectedIndex={lastSelectedIndex}
                          row={row}
                          table={table}
                        />
                      ) : (
                        flexRender(
                          cell.column.columnDef.cell,
                          cell.getContext(),
                        )
                      )}
                    </TableCell>
                  );
                })}
              </TableRow>
            );
          })}
          <BottomRow
            columns={columns}
            onFolderCreated={setEditingEntityId}
            table={table}
            workspaceId={workspaceId}
          />
        </TableBody>
      </Table>
    </div>
  );
};

type SelectRowContentProps = {
  index: number;
  label: string;
  row: Row<TreeNode>;
  table: ReactTable<TreeNode>;
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

  // Check indeterminate state for folder rows
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
      table.setRowSelection((prev) => ({ ...prev, ...patch }));
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

type FolderCellProps = {
  entity: TreeNode;
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
        <FolderOpenIcon className="size-4 shrink-0 text-muted-foreground" />
      ) : (
        <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
      )}
      {isEditing ? (
        <InlineEdit
          inputClassName="w-48"
          onChange={setEditValue}
          onCancel={() => {
            onStopEditing();
            setEditValue(name);
          }}
          onCommit={commitRename}
          value={editValue}
        />
      ) : (
        <button
          className="truncate text-left text-sm"
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
