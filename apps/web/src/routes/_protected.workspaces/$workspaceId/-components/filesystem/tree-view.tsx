import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import {
  ChevronRightIcon,
  FileIcon,
  FolderIcon,
  FolderOpenIcon,
} from "lucide-react";
import { mergeProps, useDrag, useDrop } from "react-aria";
import { useTranslations } from "use-intl";
import { useShallow } from "zustand/shallow";

import { toastManager } from "@stella/ui/components/toast";
import { cn } from "@stella/ui/lib/utils";

import {
  isFileDisplayable,
  type WorkspaceEntity,
  type WorkspaceProperty,
  type WorkspaceView,
} from "@/lib/types";
import { AddEntityMenu } from "@/routes/_protected.workspaces/$workspaceId/-components/add-entity-menu";
import { DocumentIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/document-icon";
import {
  AuthorCell,
  LastUpdatedCell,
  VersionCell,
} from "@/routes/_protected.workspaces/$workspaceId/-components/metadata-cells";
import { usePeekStore } from "@/routes/_protected.workspaces/$workspaceId/-components/peek/peek-store";
import { RowActions } from "@/routes/_protected.workspaces/$workspaceId/-components/row-actions";
import {
  useMoveEntity,
  useRenameEntity,
} from "@/routes/_protected.workspaces/$workspaceId/-mutations/entities";
import { propertiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";
import { useWorkspaceStore } from "@/routes/_protected.workspaces/$workspaceId/-store";
import {
  applyFilters,
  applySorts,
  buildTree,
  getEntityName,
  getEntityTypeLabel,
  getFieldValue,
  getFirstFile,
  type TreeNode,
} from "@/routes/_protected.workspaces/$workspaceId/-utils";

const ENTITY_DRAG_TYPE = "stella/entity-id";

// -- Column descriptors --

type ExtraColumn =
  | { type: "property"; id: string; label: string; property: WorkspaceProperty }
  | {
      type: "metadata";
      id: "__created_by__" | "__updated_at__" | "__version__";
      label: string;
    };

const ACTIONS_COL_RE = / 2rem$/;

const METADATA_IDS = new Set([
  "__created_by__",
  "__updated_at__",
  "__version__",
]);

const resolveExtraColumns = (
  visibleProperties: string[],
  properties: WorkspaceProperty[],
  metadataLabels: Record<string, string>,
): ExtraColumn[] => {
  // Empty visibleProperties = "show all" (same convention
  // as the Table view). Expand to all metadata + properties.
  const ids =
    visibleProperties.length === 0
      ? [...Array.from(METADATA_IDS), ...properties.map((p) => p.id)]
      : visibleProperties;

  const cols: ExtraColumn[] = [];

  for (const id of ids) {
    if (METADATA_IDS.has(id)) {
      cols.push({
        type: "metadata",
        id: id as "__created_by__" | "__updated_at__" | "__version__",
        label: metadataLabels[id] ?? id,
      });
    } else {
      const prop = properties.find((p) => p.id === id);
      if (prop) {
        cols.push({
          type: "property",
          id: prop.id,
          label: prop.name,
          property: prop,
        });
      }
    }
  }

  return cols;
};

// -- Grid template helpers --

const buildGridTemplate = (extraCount: number): string => {
  // Name (minmax so it never disappears) + Type (5rem)
  // + N extra columns (8rem each) + Actions (2rem)
  const extras = extraCount > 0 ? ` repeat(${extraCount}, 8rem)` : "";
  return `minmax(14rem, 1fr) 5rem${extras} 2rem`;
};

// -- Component --

type FilesystemViewProps = {
  workspaceId: string;
  view: WorkspaceView;
};

/** Collect all folder entity IDs from a flat entity list. */
const collectFolderIds = (entities: WorkspaceEntity[]): Set<string> => {
  const ids = new Set<string>();
  for (const e of entities) {
    if (e.kind === "folder") {
      ids.add(e.entityId);
    }
  }
  return ids;
};

export const FilesystemView = ({ workspaceId, view }: FilesystemViewProps) => {
  const t = useTranslations();
  const rawData = useWorkspaceStore(useShallow((s) => s.data));
  const { data: properties } = useSuspenseQuery(propertiesOptions(workspaceId));
  const moveEntity = useMoveEntity();
  const renameEntity = useRenameEntity();
  const setEntityName = useWorkspaceStore((s) => s.setEntityName);
  const rootDropRef = useRef<HTMLDivElement>(null);
  const [editingEntityId, setEditingEntityId] = useState<string | null>(null);

  const { filters, sorts, visibleProperties } = view.config;

  const data = useMemo(() => {
    const filtered = applyFilters(rawData, filters);
    return applySorts(filtered, sorts);
  }, [rawData, filters, sorts]);

  const tree = useMemo(() => buildTree(data), [data]);

  // Expanded folders state: starts with all folders expanded.
  const allFolderIds = useMemo(() => collectFolderIds(data), [data]);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(allFolderIds);
  const allExpanded =
    allFolderIds.size > 0 &&
    [...allFolderIds].every((id) => expandedIds.has(id));

  const toggleFolder = useCallback((folderId: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
      }
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    if (allExpanded) {
      setExpandedIds(new Set());
    } else {
      setExpandedIds(new Set(allFolderIds));
    }
  }, [allExpanded, allFolderIds]);

  const setFolderState = useWorkspaceStore((s) => s.setFolderState);
  const toggleVersion = useWorkspaceStore((s) => s.folderState.toggleVersion);

  useEffect(() => {
    if (toggleVersion === 0) {
      return;
    }
    toggleAll();
  }, [toggleVersion, toggleAll]);

  useEffect(() => {
    setFolderState({
      allExpanded,
      hasFolders: allFolderIds.size > 0,
    });
  }, [allExpanded, allFolderIds.size, setFolderState]);

  const metadataLabels = useMemo(
    () => ({
      __created_by__: t("workspaces.filesystem.author"),
      __updated_at__: t("workspaces.filesystem.lastUpdated"),
      __version__: t("workspaces.filesystem.version"),
    }),
    [t],
  );

  const extraColumns = useMemo(
    () => resolveExtraColumns(visibleProperties, properties, metadataLabels),
    [visibleProperties, properties, metadataLabels],
  );

  const gridTemplate = useMemo(
    () => buildGridTemplate(extraColumns.length),
    [extraColumns.length],
  );

  const { dropProps: rootDropProps, isDropTarget: isRootDropTarget } = useDrop({
    ref: rootDropRef,
    async onDrop(e) {
      for (const item of e.items) {
        if (item.kind === "text" && item.types.has(ENTITY_DRAG_TYPE)) {
          const entityId = await item.getText(ENTITY_DRAG_TYPE);
          moveEntity.mutate(
            { workspaceId, entityId, parentId: null },
            {
              onError: () => {
                toastManager.add({
                  title: t("errors.actionFailed"),
                  type: "error",
                });
              },
            },
          );
        }
      }
    },
  });

  if (data.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-muted-foreground">
        <div className="text-center">
          <FileIcon className="mx-auto mb-2 size-8" />
          <p className="text-sm">{t("workspaces.filesystem.noFilesYet")}</p>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex-1 overflow-auto p-2",
        isRootDropTarget && "bg-accent/50",
      )}
      ref={rootDropRef}
      {...rootDropProps}
    >
      <div
        className="grid items-center gap-x-4 border-b px-2 pb-1 text-xs font-medium text-muted-foreground"
        style={{ gridTemplateColumns: gridTemplate }}
      >
        <span>{t("common.name")}</span>
        <span className="text-right">{t("common.type")}</span>
        {extraColumns.map((col) => (
          <span className="text-right" key={col.id}>
            {col.label}
          </span>
        ))}
        <span />
      </div>
      <div className="mt-1">
        {tree.map((node) => (
          <FilesystemRow
            ancestorIds={new Set<string>()}
            depth={0}
            editingEntityId={editingEntityId}
            expandedIds={expandedIds}
            extraColumns={extraColumns}
            gridTemplate={gridTemplate}
            key={node.entityId}
            node={node}
            onRename={(entityId, newName) => {
              setEntityName(entityId, newName);
              renameEntity.mutate({
                workspaceId,
                entityId,
                name: newName,
              });
            }}
            onStartEditing={setEditingEntityId}
            onToggleFolder={toggleFolder}
            workspaceId={workspaceId}
          />
        ))}
      </div>
      <div className="mt-2 px-2">
        <AddEntityMenu
          onFolderCreated={setEditingEntityId}
          workspaceId={workspaceId}
        />
      </div>
    </div>
  );
};

// -- Row --

type FilesystemRowProps = {
  node: TreeNode;
  depth: number;
  workspaceId: string;
  extraColumns: ExtraColumn[];
  gridTemplate: string;
  ancestorIds: Set<string>;
  expandedIds: Set<string>;
  editingEntityId: string | null;
  onToggleFolder: (folderId: string) => void;
  onStartEditing: (entityId: string | null) => void;
  onRename: (entityId: string, newName: string) => void;
};

const FilesystemRow = ({
  node,
  depth,
  workspaceId,
  extraColumns,
  gridTemplate,
  ancestorIds,
  expandedIds,
  editingEntityId,
  onToggleFolder,
  onStartEditing,
  onRename,
}: FilesystemRowProps) => {
  const t = useTranslations();
  const [contextOpen, setContextOpen] = useState(false);
  const [editValue, setEditValue] = useState("");
  const isFolder = node.kind === "folder";
  const isEditing = editingEntityId === node.entityId;
  const expanded = isFolder && expandedIds.has(node.entityId);
  const name = getEntityName(node);

  const file = isFolder ? null : getFirstFile(node);
  const navigable = file !== null && isFileDisplayable(file);

  const startEditing = () => {
    setEditValue(name);
    onStartEditing(node.entityId);
  };

  const commitRename = () => {
    onStartEditing(null);
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== name) {
      onRename(node.entityId, trimmed);
    }
  };

  const cancelEditing = () => {
    onStartEditing(null);
  };

  const [contextAnchor, setContextAnchor] = useState<{
    getBoundingClientRect: () => DOMRect;
  } | null>(null);

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const x = e.clientX;
    const y = e.clientY;
    setContextAnchor({
      getBoundingClientRect: () => new DOMRect(x, y, 0, 0),
    });
    setContextOpen(true);
  };

  // Drag support: every row is draggable.
  const dragRef = useRef<HTMLDivElement>(null);
  const { dragProps } = useDrag({
    getItems: () => [{ [ENTITY_DRAG_TYPE]: node.entityId }],
  });

  // Drop support: only folders accept drops.
  const moveEntity = useMoveEntity();
  const dropRef = useRef<HTMLDivElement>(null);
  const { dropProps, isDropTarget } = useDrop({
    ref: dropRef,
    async onDrop(e) {
      if (!isFolder) {
        return;
      }
      for (const item of e.items) {
        if (item.kind === "text" && item.types.has(ENTITY_DRAG_TYPE)) {
          const entityId = await item.getText(ENTITY_DRAG_TYPE);
          if (entityId === node.entityId) {
            continue;
          }
          // Prevent cycles: dropping an ancestor into
          // its own descendant would break the tree.
          if (ancestorIds.has(entityId)) {
            continue;
          }
          moveEntity.mutate(
            {
              workspaceId,
              entityId,
              parentId: node.entityId,
            },
            {
              onError: () => {
                toastManager.add({
                  title: t("errors.actionFailed"),
                  type: "error",
                });
              },
            },
          );
        }
      }
    },
  });

  // Shared cells: Name + Type
  const nameCell = (
    <span
      className="flex items-center gap-1.5 truncate"
      style={{ paddingLeft: `${depth * 20}px` }}
    >
      {isFolder ? (
        <ChevronRightIcon
          className={cn(
            "size-3.5 shrink-0 transition-transform",
            expanded && "rotate-90",
          )}
        />
      ) : (
        <span className="w-3.5 shrink-0" />
      )}
      {isFolder ? (
        expanded ? (
          <FolderOpenIcon className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
        )
      ) : file?.mimeType ? (
        <DocumentIcon className="size-4 shrink-0" mimeType={file.mimeType} />
      ) : (
        <FileIcon className="size-4 shrink-0 text-muted-foreground" />
      )}
      {isEditing ? (
        <input
          autoFocus
          className="h-auto w-48 border-0 bg-transparent p-0 text-sm outline-none"
          onBlur={commitRename}
          onChange={(e) => setEditValue(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            // Stop propagation so react-aria drag handlers
            // don't intercept space/arrow keys.
            e.stopPropagation();
            if (e.key === "Enter") {
              e.currentTarget.blur();
            }
            if (e.key === "Escape") {
              cancelEditing();
            }
          }}
          value={editValue}
        />
      ) : (
        <span className="truncate">{name}</span>
      )}
    </span>
  );

  const typeCell = (
    <span className="truncate text-right text-xs text-muted-foreground">
      {getEntityTypeLabel(node)}
    </span>
  );

  const extraCells = extraColumns.map((col) => (
    <span className="text-right" key={col.id}>
      <ExtraColumnCell column={col} entity={node} />
    </span>
  ));

  const gridCls = cn(
    "grid w-full items-center gap-x-4 rounded px-2 py-1 text-left text-sm hover:bg-muted",
    isDropTarget && isFolder && "bg-accent ring-2 ring-primary",
  );

  // Content area: Name + Type + extras (interactive, clickable)
  // gridColumn spans all content columns (excluding the actions column)
  const contentSpanStyle = {
    gridColumn: "1 / -2",
    display: "grid",
    gridTemplateColumns: gridTemplate.replace(ACTIONS_COL_RE, ""),
    alignItems: "center",
    columnGap: "1rem",
  } as const;
  const contentCells = (
    <>
      {nameCell}
      {typeCell}
      {extraCells}
    </>
  );

  // Merge drag and drop props onto the wrapper div.
  // mergeProps chains overlapping event handlers (e.g. onKeyDown)
  // instead of one silently overwriting the other.
  const combinedProps = isFolder ? mergeProps(dragProps, dropProps) : dragProps;

  const combinedRef = useCallback(
    (el: HTMLDivElement | null) => {
      dragRef.current = el;
      if (isFolder) {
        dropRef.current = el;
      }
    },
    [isFolder],
  );

  return (
    <>
      {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: context menu on row */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: context menu on row */}
      <div
        className="group/row"
        onContextMenu={handleContextMenu}
        ref={combinedRef}
        {...combinedProps}
      >
        {isFolder ? (
          <div
            className={gridCls}
            style={{ gridTemplateColumns: gridTemplate }}
          >
            <button
              className="text-left"
              onClick={() => onToggleFolder(node.entityId)}
              style={contentSpanStyle}
              type="button"
            >
              {contentCells}
            </button>
            <span className="flex justify-end">
              <RowActions
                anchor={contextAnchor}
                entity={node}
                onOpenChange={(o) => {
                  setContextOpen(o);
                  if (!o) {
                    setContextAnchor(null);
                  }
                }}
                onRename={startEditing}
                open={contextOpen}
                workspaceId={workspaceId}
              />
            </span>
          </div>
        ) : navigable && file ? (
          <div
            className={gridCls}
            style={{ gridTemplateColumns: gridTemplate }}
          >
            <button
              onClick={() =>
                usePeekStore.getState().openTab({
                  fieldId: file.fieldId,
                  entityId: file.entityId,
                  label: name,
                })
              }
              style={contentSpanStyle}
              type="button"
            >
              {contentCells}
            </button>
            <span className="flex justify-end">
              <RowActions
                anchor={contextAnchor}
                entity={node}
                onOpenChange={(o) => {
                  setContextOpen(o);
                  if (!o) {
                    setContextAnchor(null);
                  }
                }}
                onRename={startEditing}
                open={contextOpen}
                workspaceId={workspaceId}
              />
            </span>
          </div>
        ) : (
          <div
            className={gridCls}
            style={{ gridTemplateColumns: gridTemplate }}
          >
            {contentCells}
            <span className="flex justify-end">
              <RowActions
                anchor={contextAnchor}
                entity={node}
                onOpenChange={(o) => {
                  setContextOpen(o);
                  if (!o) {
                    setContextAnchor(null);
                  }
                }}
                onRename={startEditing}
                open={contextOpen}
                workspaceId={workspaceId}
              />
            </span>
          </div>
        )}
      </div>
      {isFolder && expanded && (
        <div>
          {node.children.map((child) => (
            <FilesystemRow
              ancestorIds={new Set([...ancestorIds, node.entityId])}
              depth={depth + 1}
              editingEntityId={editingEntityId}
              expandedIds={expandedIds}
              extraColumns={extraColumns}
              gridTemplate={gridTemplate}
              key={child.entityId}
              node={child}
              onRename={onRename}
              onStartEditing={onStartEditing}
              onToggleFolder={onToggleFolder}
              workspaceId={workspaceId}
            />
          ))}
        </div>
      )}
    </>
  );
};

// -- Extra column cell renderer --

type ExtraColumnCellProps = {
  column: ExtraColumn;
  entity: WorkspaceEntity;
};

const formatDateValue = (value: string | Date | null | undefined): string => {
  if (!value) {
    return "";
  }
  return new Date(value).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
};

const ExtraColumnCell = ({ column, entity }: ExtraColumnCellProps) => {
  if (column.type === "metadata") {
    switch (column.id) {
      case "__created_by__":
        return <AuthorCell entity={entity} />;
      case "__updated_at__":
        return <LastUpdatedCell entity={entity} />;
      case "__version__":
        return <VersionCell entity={entity} />;
      default:
        return null;
    }
  }

  // Regular property
  const field = entity.fields[column.id];

  // Date fields need explicit formatting; raw Date objects
  // crash React ("Objects are not valid as a React child").
  if (field?.content.type === "date") {
    const formatted = formatDateValue(field.content.value);
    return (
      <span className="truncate text-xs text-muted-foreground">
        {formatted || "-"}
      </span>
    );
  }

  const value = getFieldValue(field);

  return (
    <span className="truncate text-xs text-muted-foreground">
      {value || "-"}
    </span>
  );
};
