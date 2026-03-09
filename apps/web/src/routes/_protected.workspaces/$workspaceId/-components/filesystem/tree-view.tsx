import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  ChevronRightIcon,
  FileIcon,
  FileTextIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderPlusIcon,
} from "lucide-react";
import { mergeProps, useDrag, useDrop } from "react-aria";
import { useTranslations } from "use-intl";

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbSeparator,
} from "@stella/ui/components/breadcrumb";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuTrigger,
} from "@stella/ui/components/menu";
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
import { EmptyState } from "@/routes/_protected.workspaces/$workspaceId/-components/empty-state";
import { InlineEdit } from "@/routes/_protected.workspaces/$workspaceId/-components/inline-edit";
import {
  AuthorCell,
  LastUpdatedCell,
  VersionCell,
} from "@/routes/_protected.workspaces/$workspaceId/-components/metadata-cells";
import { usePeekStore } from "@/routes/_protected.workspaces/$workspaceId/-components/peek/peek-store";
import { RowActions } from "@/routes/_protected.workspaces/$workspaceId/-components/row-actions";
import type { TableTreeNode } from "@/routes/_protected.workspaces/$workspaceId/-components/table/types";
import {
  useCreateEntities,
  useMoveEntity,
  useRenameEntity,
} from "@/routes/_protected.workspaces/$workspaceId/-mutations/entities";
import { entitiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import { propertiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";
import { useWorkspaceStore } from "@/routes/_protected.workspaces/$workspaceId/-store";
import {
  buildTree,
  findNode,
  getEntityName,
  getFieldValue,
  getFirstFile,
  getInternalPropertyId,
  type InternalPropertyId,
} from "@/routes/_protected.workspaces/$workspaceId/-utils";

const ENTITY_DRAG_TYPE = "stella/entity-id";

// -- Column descriptors --

type ExtraColumn =
  | { type: "property"; id: string; label: string; property: WorkspaceProperty }
  | {
      type: "metadata";
      id: InternalPropertyId;
      label: string;
    };

const ACTIONS_COL_RE = / 2rem$/;

const METADATA_IDS = new Set<string>([
  getInternalPropertyId("created-by"),
  getInternalPropertyId("updated-at"),
  getInternalPropertyId("version"),
]);

const resolveExtraColumns = (
  hiddenProperties: string[],
  properties: WorkspaceProperty[],
  metadataLabels: Record<string, string>,
): ExtraColumn[] => {
  const ids = [
    ...Array.from(METADATA_IDS),
    ...properties.map((p) => p.id),
  ].filter((id) => !hiddenProperties.includes(id));

  const cols: ExtraColumn[] = [];

  for (const id of ids) {
    if (METADATA_IDS.has(id)) {
      cols.push({
        type: "metadata",
        id: id as InternalPropertyId,
        label: metadataLabels[id] ?? id,
      });
    } else {
      const prop = properties.find((p) => p.id === id);
      // Skip file-type properties — the Name column already
      // shows the filename, so a "Documents" column is redundant.
      if (prop && prop.content.type !== "file") {
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
  // Name (flex) + N extra columns (8rem each) + Actions
  const extras = extraCount > 0 ? ` repeat(${extraCount}, 8rem)` : "";
  return `minmax(14rem, 1fr)${extras} 2rem`;
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
  const { data: properties } = useSuspenseQuery(propertiesOptions(workspaceId));
  const createEntities = useCreateEntities();
  const moveEntity = useMoveEntity();
  const renameEntity = useRenameEntity();
  const rootDropRef = useRef<HTMLDivElement>(null);
  const [editingEntityId, setEditingEntityId] = useState<string | null>(null);
  const [breadcrumbEditValue, setBreadcrumbEditValue] = useState("");

  // Background right-click context menu
  const [bgContextOpen, setBgContextOpen] = useState(false);
  const [bgContextAnchor, setBgContextAnchor] = useState<{
    getBoundingClientRect: () => DOMRect;
  } | null>(null);

  const { filters, sorts, hiddenProperties } = view.layout;

  const { data: entityData } = useSuspenseQuery(
    entitiesOptions({ workspaceId, filters, sorts, page: 1 }),
  );
  const data = entityData.entities;

  const tree = useMemo(() => buildTree(data), [data]);

  // Drill-down navigation (persisted in URL search params)
  const currentFolderId = useSearch({
    from: "/_protected/workspaces/$workspaceId/$viewId",
    select: (s) => s.folder,
  });
  const navigate = useNavigate();

  const visibleNodes = useMemo(() => {
    if (!currentFolderId) {
      return tree;
    }
    const target = findNode(tree, currentFolderId);
    return target ? target.children : tree;
  }, [tree, currentFolderId]);

  const breadcrumbs = useMemo(() => {
    if (!currentFolderId) {
      return [];
    }
    const trail: { id: string; name: string }[] = [];
    const nodeMap = new Map(data.map((e) => [e.entityId, e]));
    let current = nodeMap.get(currentFolderId);
    while (current) {
      trail.unshift({
        id: current.entityId,
        name: getEntityName(current),
      });
      current = current.parentId ? nodeMap.get(current.parentId) : undefined;
    }
    return trail;
  }, [currentFolderId, data]);

  const navigateToFolder = useCallback(
    async (folderId: string | undefined) => {
      await navigate({
        from: "/workspaces/$workspaceId/$viewId",
        search: (prev) => ({ ...prev, folder: folderId }),
        replace: true,
      });
    },
    [navigate],
  );

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
      [getInternalPropertyId("created-by")]: t("workspaces.filesystem.author"),
      [getInternalPropertyId("updated-at")]: t(
        "workspaces.filesystem.lastUpdated",
      ),
      [getInternalPropertyId("version")]: t("workspaces.filesystem.version"),
    }),
    [t],
  );

  const extraColumns = useMemo(
    () => resolveExtraColumns(hiddenProperties, properties, metadataLabels),
    [hiddenProperties, properties, metadataLabels],
  );

  const gridTemplate = useMemo(
    () => buildGridTemplate(extraColumns.length),
    [extraColumns.length],
  );

  const handleBgContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const x = e.clientX;
    const y = e.clientY;
    setBgContextAnchor({
      getBoundingClientRect: () => new DOMRect(x, y, 0, 0),
    });
    setBgContextOpen(true);
  }, []);

  const handleCreateEntity = useCallback(
    (kind: "document" | "folder") => {
      createEntities.mutate(
        {
          workspaceId,
          type: "manual-input",
          kind,
          parentId: currentFolderId ?? undefined,
          name: kind === "folder" ? t("workspaces.newFolder") : undefined,
        },
        {
          onSuccess: (data) => {
            toastManager.add({
              title:
                kind === "folder"
                  ? t("success.folderCreated")
                  : t("success.documentCreated"),
              type: "success",
            });
            if (kind === "folder" && data?.entityId) {
              setEditingEntityId(data.entityId);
              setExpandedIds((prev) => new Set([...prev, data.entityId]));
            }
          },
          onError: () => {
            toastManager.add({
              title: t("errors.actionFailed"),
              type: "error",
            });
          },
        },
      );
    },
    [createEntities, workspaceId, currentFolderId, t],
  );

  const handleDropOnFile = useCallback(
    (
      draggedEntityId: string,
      targetEntityId: string,
      targetParentId: string | null,
    ) => {
      createEntities.mutate(
        {
          workspaceId,
          type: "manual-input",
          kind: "folder",
          parentId: targetParentId ?? undefined,
          name: t("workspaces.newFolder"),
        },
        {
          onSuccess: (result) => {
            if (result?.entityId) {
              moveEntity.mutate({
                workspaceId,
                entityId: targetEntityId,
                parentId: result.entityId,
              });
              moveEntity.mutate({
                workspaceId,
                entityId: draggedEntityId,
                parentId: result.entityId,
              });
              setEditingEntityId(result.entityId);
              setExpandedIds((prev) => new Set([...prev, result.entityId]));
            }
          },
          onError: () => {
            toastManager.add({
              title: t("errors.actionFailed"),
              type: "error",
            });
          },
        },
      );
    },
    [createEntities, moveEntity, workspaceId, t],
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
      <EmptyState
        icon={FileIcon}
        message={t("workspaces.filesystem.noFilesYet")}
        workspaceId={workspaceId}
      />
    );
  }

  return (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: context menu on background
    // biome-ignore lint/a11y/noStaticElementInteractions: context menu on background
    <div
      className={cn(
        "flex-1 overflow-auto p-2",
        isRootDropTarget && "bg-accent/50",
      )}
      onContextMenu={handleBgContextMenu}
      ref={rootDropRef}
      {...rootDropProps}
    >
      {currentFolderId && (
        <div className="mb-2 px-2">
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <button
                  className="text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => navigateToFolder(undefined)}
                  type="button"
                >
                  <FolderIcon className="size-3.5" />
                </button>
              </BreadcrumbItem>
              {breadcrumbs.map((crumb, i) => {
                const isLast = i === breadcrumbs.length - 1;
                const isEditingCrumb = isLast && editingEntityId === crumb.id;
                return (
                  <Fragment key={crumb.id}>
                    <BreadcrumbSeparator />
                    <BreadcrumbItem>
                      {isEditingCrumb ? (
                        <InlineEdit
                          inputClassName="h-5 w-40 text-xs"
                          onCancel={() => setEditingEntityId(null)}
                          onChange={setBreadcrumbEditValue}
                          onCommit={() => {
                            const trimmed = breadcrumbEditValue.trim();
                            setEditingEntityId(null);
                            if (trimmed && trimmed !== crumb.name) {
                              renameEntity.mutate({
                                workspaceId,
                                entityId: crumb.id,
                                name: trimmed,
                              });
                            }
                          }}
                          value={breadcrumbEditValue}
                        />
                      ) : isLast ? (
                        <button
                          className="text-xs font-medium"
                          onClick={() => navigateToFolder(undefined)}
                          onDoubleClick={(e) => {
                            e.stopPropagation();
                            setBreadcrumbEditValue(crumb.name);
                            setEditingEntityId(crumb.id);
                          }}
                          type="button"
                        >
                          {crumb.name}
                        </button>
                      ) : (
                        <button
                          className="text-xs text-muted-foreground hover:text-foreground"
                          onClick={() => navigateToFolder(crumb.id)}
                          type="button"
                        >
                          {crumb.name}
                        </button>
                      )}
                    </BreadcrumbItem>
                  </Fragment>
                );
              })}
            </BreadcrumbList>
          </Breadcrumb>
        </div>
      )}
      <div
        className="grid items-center gap-x-4 border-b px-2 pb-1 text-xs font-medium text-muted-foreground"
        style={{ gridTemplateColumns: gridTemplate }}
      >
        <span>{t("common.name")}</span>
        {extraColumns.map((col) => (
          <span className="text-right" key={col.id}>
            {col.label}
          </span>
        ))}
        <span />
      </div>
      <div className="mt-1">
        {visibleNodes.map((node) => (
          <FilesystemRow
            ancestorIds={new Set<string>()}
            currentFolderId={currentFolderId}
            depth={currentFolderId ? 0 : undefined}
            editingEntityId={editingEntityId}
            expandedIds={expandedIds}
            extraColumns={extraColumns}
            gridTemplate={gridTemplate}
            key={node.entityId}
            node={node}
            onDropOnFile={handleDropOnFile}
            onNavigateToFolder={navigateToFolder}
            onRename={(entityId, newName) => {
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
          parentId={currentFolderId}
          workspaceId={workspaceId}
        />
      </div>
      {/* Background right-click context menu */}
      <Menu
        onOpenChange={(o) => {
          setBgContextOpen(o);
          if (!o) {
            setBgContextAnchor(null);
          }
        }}
        open={bgContextOpen}
      >
        <MenuTrigger render={<span className="sr-only" />} />
        <MenuPopup anchor={bgContextAnchor ?? undefined}>
          <MenuItem onClick={() => handleCreateEntity("document")}>
            <FileTextIcon />
            {t("workspaces.newDocument")}
          </MenuItem>
          <MenuItem onClick={() => handleCreateEntity("folder")}>
            <FolderPlusIcon />
            {t("workspaces.newFolder")}
          </MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
};

// -- Row --

type FilesystemRowProps = {
  node: TableTreeNode;
  depth: number | undefined;
  workspaceId: string;
  extraColumns: ExtraColumn[];
  gridTemplate: string;
  ancestorIds: Set<string>;
  expandedIds: Set<string>;
  editingEntityId: string | null;
  currentFolderId: string | undefined;
  onToggleFolder: (folderId: string) => void;
  onNavigateToFolder: (folderId: string) => void;
  onStartEditing: (entityId: string | null) => void;
  onRename: (entityId: string, newName: string) => void;
  onDropOnFile: (
    draggedEntityId: string,
    targetEntityId: string,
    targetParentId: string | null,
  ) => void;
};

const FilesystemRow = ({
  node,
  depth = 0,
  workspaceId,
  extraColumns,
  gridTemplate,
  ancestorIds,
  expandedIds,
  editingEntityId,
  currentFolderId,
  onToggleFolder,
  onNavigateToFolder,
  onStartEditing,
  onRename,
  onDropOnFile,
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

  // Preserve file extension during rename
  const extIndex = isFolder ? -1 : name.lastIndexOf(".");
  const ext = extIndex > 0 ? name.slice(extIndex) : "";
  const baseName = extIndex > 0 ? name.slice(0, extIndex) : name;

  const startEditing = () => {
    setEditValue(baseName);
    onStartEditing(node.entityId);
  };

  const commitRename = () => {
    onStartEditing(null);
    const trimmed = editValue.trim();
    const fullName = ext ? `${trimmed}${ext}` : trimmed;
    if (trimmed && fullName !== name) {
      onRename(node.entityId, fullName);
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
    e.stopPropagation();
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
          if (isFolder) {
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
          } else {
            onDropOnFile(entityId, node.entityId, node.parentId ?? null);
          }
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
        <InlineEdit
          inputClassName="w-48"
          onCancel={cancelEditing}
          onChange={setEditValue}
          onCommit={commitRename}
          suffix={
            ext ? (
              <span className="text-sm text-muted-foreground">{ext}</span>
            ) : undefined
          }
          value={editValue}
        />
      ) : (
        <span className="truncate">{name}</span>
      )}
    </span>
  );

  const extraCells = extraColumns.map((col) => (
    <span className="text-right text-xs text-muted-foreground" key={col.id}>
      <ExtraColumnCell column={col} entity={node} />
    </span>
  ));

  const gridCls = cn(
    "grid w-full items-center gap-x-4 rounded px-2 py-1 text-left text-sm hover:bg-muted",
    isDropTarget && "bg-accent ring-2 ring-primary",
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
      {extraCells}
    </>
  );

  // Merge drag and drop props onto the wrapper div.
  // mergeProps chains overlapping event handlers (e.g. onKeyDown)
  // instead of one silently overwriting the other.
  const combinedProps = mergeProps(dragProps, dropProps);

  const combinedRef = useCallback((el: HTMLDivElement | null) => {
    dragRef.current = el;
    dropRef.current = el;
  }, []);

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
              onClick={() => {
                if (currentFolderId) {
                  onNavigateToFolder(node.entityId);
                } else {
                  onToggleFolder(node.entityId);
                }
              }}
              onDoubleClick={() => onNavigateToFolder(node.entityId)}
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
              currentFolderId={currentFolderId}
              depth={depth + 1}
              editingEntityId={editingEntityId}
              expandedIds={expandedIds}
              extraColumns={extraColumns}
              gridTemplate={gridTemplate}
              key={child.entityId}
              node={child}
              onDropOnFile={onDropOnFile}
              onNavigateToFolder={onNavigateToFolder}
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
      case getInternalPropertyId("created-by"):
        return <AuthorCell entity={entity} />;
      case getInternalPropertyId("updated-at"):
        return <LastUpdatedCell entity={entity} />;
      case getInternalPropertyId("version"):
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
