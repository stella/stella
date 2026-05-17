import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import {
  draggable,
  dropTargetForElements,
  monitorForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { setCustomNativeDragPreview } from "@atlaskit/pragmatic-drag-and-drop/element/set-custom-native-drag-preview";
import { useHotkey } from "@tanstack/react-hotkeys";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronRightIcon,
  EyeOffIcon,
  FileIcon,
  FolderIcon,
  FolderOpenIcon,
} from "lucide-react";
import { useLocale, useTranslations } from "use-intl";

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbSeparator,
} from "@stll/ui/components/breadcrumb";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuTrigger,
} from "@stll/ui/components/menu";
import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";

import {
  renderDragPreview,
  renderMultiDragPreview,
} from "@/components/drag-preview";
import type { DragPreviewData } from "@/components/drag-preview";
import { HOTKEYS } from "@/lib/hotkeys";
import { isFileDisplayable } from "@/lib/types";
import type {
  ViewLayout,
  WorkspaceEntity,
  WorkspaceProperty,
  WorkspaceView,
} from "@/lib/types";
import { ActiveEditBadge } from "@/routes/_protected.workspaces/$workspaceId/-components/active-edit-badge";
import { AddEntityMenu } from "@/routes/_protected.workspaces/$workspaceId/-components/add-entity-menu";
import { DocumentIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/document-icon";
import { ENTITY_DRAG_TYPE } from "@/routes/_protected.workspaces/$workspaceId/-components/drag-constants";
import { EmptyState } from "@/routes/_protected.workspaces/$workspaceId/-components/empty-state";
import { flattenFilesystemRows } from "@/routes/_protected.workspaces/$workspaceId/-components/filesystem/tree-virtualization";
import { InlineEdit } from "@/routes/_protected.workspaces/$workspaceId/-components/inline-edit";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import type { FileTab } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import {
  AuthorCell,
  LastUpdatedCell,
  VersionCell,
} from "@/routes/_protected.workspaces/$workspaceId/-components/metadata-cells";
import { RowActions } from "@/routes/_protected.workspaces/$workspaceId/-components/row-actions";
import type { TableTreeNode } from "@/routes/_protected.workspaces/$workspaceId/-components/table/types";
import { useInspectorFlash } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-inspector-flash";
import {
  useMoveEntity,
  useRenameEntity,
} from "@/routes/_protected.workspaces/$workspaceId/-mutations/entities";
import { useUpdateView } from "@/routes/_protected.workspaces/$workspaceId/-mutations/views";
import {
  useFilesystemEntitiesOptions,
  visibleEntityFieldIds,
} from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import { propertiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";
import { useWorkspaceStore } from "@/routes/_protected.workspaces/$workspaceId/-store";
import {
  buildTree,
  findNode,
  getEntityName,
  getFieldValue,
  getFirstFile,
  getInternalPropertyId,
} from "@/routes/_protected.workspaces/$workspaceId/-utils";
import type { InternalPropertyId } from "@/routes/_protected.workspaces/$workspaceId/-utils";

const FILESYSTEM_ROW_HEIGHT_PX = 36;
const FILESYSTEM_ROW_OVERSCAN = 16;
const FILESYSTEM_INDENT_PX = 20;
const FILESYSTEM_GUIDE_OFFSET_PX = 10;
const FILESYSTEM_GUIDE_LINE_COLOR_CLASS = "bg-muted-foreground/30";
const FILESYSTEM_CREATED_BY_ID = "_created-by" satisfies InternalPropertyId;
const FILESYSTEM_UPDATED_AT_ID = "_updated-at" satisfies InternalPropertyId;
const FILESYSTEM_VERSION_ID = "_version" satisfies InternalPropertyId;
const FILESYSTEM_METADATA_IDS = [
  FILESYSTEM_CREATED_BY_ID,
  FILESYSTEM_UPDATED_AT_ID,
  FILESYSTEM_VERSION_ID,
] as const;

// -- Column descriptors --

type FilesystemMetadataId = (typeof FILESYSTEM_METADATA_IDS)[number];

type ExtraColumn =
  | { type: "property"; id: string; label: string; property: WorkspaceProperty }
  | {
      type: "metadata";
      id: FilesystemMetadataId;
      label: string;
    };

const ACTIONS_COL_RE = / 2rem$/;

const isFilesystemMetadataId = (id: string): id is FilesystemMetadataId =>
  FILESYSTEM_METADATA_IDS.some((metadataId) => metadataId === id);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasNullableParentId = (
  value: unknown,
): value is { parentId: string | null } => {
  if (!isRecord(value)) {
    return false;
  }

  const parentId = value["parentId"];
  return typeof parentId === "string" || parentId === null;
};

const isDragEntityList = (
  value: unknown,
): value is { parentId: string | null }[] =>
  Array.isArray(value) && value.every(hasNullableParentId);

const getDragEntityId = (
  data: Record<string | symbol, unknown>,
): string | null => {
  const entityId = data["entityId"];
  return typeof entityId === "string" ? entityId : null;
};

const getDragEntityIds = (
  data: Record<string | symbol, unknown>,
): string[] | null => {
  const entityIds = data["entityIds"];
  return isStringArray(entityIds) ? entityIds : null;
};

const resolveExtraColumns = (
  hiddenProperties: string[],
  properties: WorkspaceProperty[],
  metadataLabels: Record<string, string>,
): ExtraColumn[] => {
  const propertyById = new Map(
    properties.map((property) => [property.id, property]),
  );
  const ids = [
    ...FILESYSTEM_METADATA_IDS,
    ...properties.map((p) => p.id),
  ].filter((id) => !hiddenProperties.includes(id));

  const cols: ExtraColumn[] = [];

  for (const id of ids) {
    if (isFilesystemMetadataId(id)) {
      cols.push({
        type: "metadata",
        id,
        label: metadataLabels[id] ?? id,
      });
    } else {
      const prop = propertyById.get(id);
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

const NAME_COL_ID = "__name__";
const DEFAULT_EXTRA_WIDTH_PX = 128;
const MIN_COL_WIDTH_PX = 80;
const MAX_COL_WIDTH_PX = 800;

const buildGridTemplate = (
  extraColumns: ExtraColumn[],
  widths: Record<string, number>,
): string => {
  const nameWidth = widths[NAME_COL_ID];
  const nameTrack =
    nameWidth !== undefined ? `${nameWidth}px` : "minmax(20rem, 1fr)";
  const extraTracks = extraColumns
    .map((col) => `${widths[col.id] ?? DEFAULT_EXTRA_WIDTH_PX}px`)
    .join(" ");
  return `${nameTrack}${extraTracks ? ` ${extraTracks}` : ""} 2rem`;
};

type ColumnWidthsApi = {
  widths: Record<string, number>;
  setWidth: (id: string, width: number) => void;
};

const useColumnWidths = (storageKey: string): ColumnWidthsApi => {
  const [widths, setWidths] = useState<Record<string, number>>(() => {
    if (typeof window === "undefined") {
      return {};
    }
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) {
        return {};
      }
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object") {
        return {};
      }
      const result: Record<string, number> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "number" && Number.isFinite(value)) {
          result[key] = value;
        }
      }
      return result;
    } catch {
      return {};
    }
  });

  const setWidth = useCallback(
    (id: string, width: number) => {
      const clamped = Math.max(
        MIN_COL_WIDTH_PX,
        Math.min(MAX_COL_WIDTH_PX, Math.round(width)),
      );
      setWidths((prev) => {
        if (prev[id] === clamped) {
          return prev;
        }
        const next = { ...prev, [id]: clamped };
        try {
          window.localStorage.setItem(storageKey, JSON.stringify(next));
        } catch {
          // Ignore quota / unavailable storage.
        }
        return next;
      });
    },
    [storageKey],
  );

  return { widths, setWidth };
};

// -- Component --

type FilesystemViewProps = {
  workspaceId: string;
  view: WorkspaceView<"filesystem">;
};

/** Collect all folder entity IDs from a flat entity list. */
const collectFolderIds = (
  entities: readonly WorkspaceEntity[],
): Set<string> => {
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
  const moveEntity = useMoveEntity();
  const renameEntity = useRenameEntity();
  const updateView = useUpdateView(workspaceId);
  const [editingEntityId, setEditingEntityId] = useState<string | null>(null);
  const [breadcrumbEditValue, setBreadcrumbEditValue] = useState("");
  const [selectedIds, setSelectedIds] = useState(new Set<string>());
  const setFilesystemSelectedIds = useWorkspaceStore(
    (s) => s.setFilesystemSelectedIds,
  );
  const clearFilesystemSelectedIds = useWorkspaceStore(
    (s) => s.clearFilesystemSelectedIds,
  );

  const handleSelect = useCallback((entityId: string, meta: boolean) => {
    setSelectedIds((prev) => {
      if (meta) {
        const next = new Set(prev);
        if (next.has(entityId)) {
          next.delete(entityId);
        } else {
          next.add(entityId);
        }
        return next;
      }
      // Single click: toggle if already the sole selection,
      // otherwise select only this item.
      if (prev.size === 1 && prev.has(entityId)) {
        return new Set();
      }
      return new Set([entityId]);
    });
  }, []);

  // Background right-click context menu
  const [bgContextAnchor, setBgContextAnchor] = useState<{
    getBoundingClientRect: () => DOMRect;
  } | null>(null);
  const isBgContextOpen = bgContextAnchor !== null;

  const { filters, sorts, hiddenProperties } = view.layout;
  const primarySort = sorts.at(0) ?? null;
  const fieldIds = useMemo(
    () => visibleEntityFieldIds({ hiddenProperties, properties }),
    [hiddenProperties, properties],
  );

  const handleSortColumn = useCallback(
    (propertyId: string) => {
      const desc =
        primarySort?.propertyId === propertyId ? !primarySort.desc : false;
      updateView.mutate({
        viewId: view.id,
        layout: {
          ...view.layout,
          sorts: [
            { propertyId, desc },
            ...view.layout.sorts.filter(
              (sort) => sort.propertyId !== propertyId,
            ),
          ],
        },
      });
    },
    [primarySort, updateView, view.id, view.layout],
  );

  const { data: entityData } = useSuspenseQuery(
    useFilesystemEntitiesOptions({
      workspaceId,
      filters,
      sorts,
      fieldMode: "visible",
      fieldIds,
    }),
  );
  const data = entityData.entities;

  // Build a lookup for drag preview data from selected entities.
  const entityMap = useMemo(() => {
    const map = new Map<string, WorkspaceEntity>();
    for (const e of data) {
      map.set(e.entityId, e);
    }
    return map;
  }, [data]);

  const getSelectedDragItems = useCallback(
    (entityIds: Set<string>): DragPreviewData[] => {
      const items: DragPreviewData[] = [];
      for (const id of entityIds) {
        const entity = entityMap.get(id);
        if (entity) {
          const f = getFirstFile(entity);
          items.push({
            name: getEntityName(entity),
            kind: entity.kind,
            mimeType: f?.mimeType ?? null,
          });
        }
      }
      return items;
    },
    [entityMap],
  );

  const getSelectedEntities = useCallback(
    (ids: Set<string>): WorkspaceEntity[] => {
      const entities: WorkspaceEntity[] = [];
      for (const id of ids) {
        const entity = entityMap.get(id);
        if (entity) {
          entities.push(entity);
        }
      }
      return entities;
    },
    [entityMap],
  );

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

  // Cmd+A: select all visible entities.
  const allVisibleIds = useMemo(() => {
    const ids = new Set<string>();
    const collect = (nodes: readonly TableTreeNode[]) => {
      for (const n of nodes) {
        ids.add(n.entityId);
        if (n.children.length > 0) {
          collect(n.children);
        }
      }
    };
    collect(visibleNodes);
    return ids;
  }, [visibleNodes]);

  useHotkey(
    HOTKEYS.SELECT_ALL,
    () => {
      setSelectedIds(allVisibleIds);
    },
    { ignoreInputs: true },
  );

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  useHotkey("Escape", clearSelection, { ignoreInputs: true });

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
    async (folderId?: string) => {
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
  const [expandedIds, setExpandedIds] = useState(allFolderIds);
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

  // Toggle all folders when the header button is clicked.
  // Only react to `toggleVersion` changes; `toggleAll` is
  // intentionally excluded to avoid an infinite loop
  // (toggleAll → allExpanded → setFolderState → re-render).
  const toggleAllRef = useRef(toggleAll);
  toggleAllRef.current = toggleAll;
  useEffect(() => {
    if (toggleVersion === 0) {
      return;
    }
    toggleAllRef.current();
  }, [toggleVersion]);

  useEffect(() => {
    setFolderState({
      allExpanded,
      hasFolders: allFolderIds.size > 0,
    });
  }, [allExpanded, allFolderIds.size, setFolderState]);

  const metadataLabels = useMemo(
    () => ({
      [FILESYSTEM_CREATED_BY_ID]: t("workspaces.filesystem.author"),
      [FILESYSTEM_UPDATED_AT_ID]: t("workspaces.filesystem.lastUpdated"),
      [FILESYSTEM_VERSION_ID]: t("workspaces.filesystem.version"),
    }),
    [t],
  );

  const extraColumns = useMemo(
    () => resolveExtraColumns(hiddenProperties, properties, metadataLabels),
    [hiddenProperties, properties, metadataLabels],
  );

  const { widths: columnWidths, setWidth: setColumnWidth } = useColumnWidths(
    `stella.tree-view.column-widths.${view.id}`,
  );

  const gridTemplate = useMemo(
    () => buildGridTemplate(extraColumns, columnWidths),
    [columnWidths, extraColumns],
  );

  const handleHideColumn = useCallback(
    (propertyId: string) => {
      updateView.mutate({
        viewId: view.id,
        // SAFETY: hiddenProperties is part of every layout discriminant.
        layout: {
          ...view.layout,
          hiddenProperties: [...new Set([...hiddenProperties, propertyId])],
        } as ViewLayout,
      });
    },
    [hiddenProperties, updateView, view.id, view.layout],
  );

  const handleBgContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const x = e.clientX;
    const y = e.clientY;
    setBgContextAnchor({
      getBoundingClientRect: () => new DOMRect(x, y, 0, 0),
    });
  }, []);

  const handleFolderCreated = useCallback((entityId: string) => {
    setEditingEntityId(entityId);
    setExpandedIds((prev) => new Set(prev).add(entityId));
  }, []);

  const handleSubfolderCreated = useCallback(
    (entityId: string, parentId: string) => {
      setEditingEntityId(entityId);
      setExpandedIds((prev) => new Set(prev).add(parentId).add(entityId));
    },
    [],
  );

  const flattenedRows = useMemo(
    () => flattenFilesystemRows(visibleNodes, expandedIds),
    [visibleNodes, expandedIds],
  );
  const rowsViewportRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: flattenedRows.length,
    getScrollElement: () => rowsViewportRef.current,
    estimateSize: () => FILESYSTEM_ROW_HEIGHT_PX,
    getItemKey: (index) => flattenedRows.at(index)?.node.entityId ?? index,
    overscan: FILESYSTEM_ROW_OVERSCAN,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();

  const [isRootDropTarget, setIsRootDropTarget] = useState(false);
  const [isDragActive, setIsDragActive] = useState(false);
  const rootBarRef = useRef<HTMLDivElement>(null);
  const moveEntityRefRoot = useRef(moveEntity);
  moveEntityRefRoot.current = moveEntity;

  // Track whether an entity drag is active and whether any
  // dragged entity is nested (has a parentId). Only show the
  // root drop bar when at least one entity can be moved to root.
  useEffect(
    () =>
      monitorForElements({
        canMonitor: ({ source }) => source.data["type"] === ENTITY_DRAG_TYPE,
        onDragStart: ({ source }) => {
          const entities = source.data["entities"];
          const parentId = source.data["parentId"];
          const hasNested = isDragEntityList(entities)
            ? entities.some((entity) => entity.parentId !== null)
            : typeof parentId === "string";
          if (hasNested) {
            setIsDragActive(true);
          }
        },
        onDrop: () => setIsDragActive(false),
      }),
    [],
  );

  useEffect(() => {
    setFilesystemSelectedIds(selectedIds);
  }, [selectedIds, setFilesystemSelectedIds]);

  useEffect(() => clearFilesystemSelectedIds, [clearFilesystemSelectedIds]);

  // Dedicated root-level drop bar (visible during drags).
  useEffect(() => {
    const el = rootBarRef.current;
    if (!el) {
      return undefined;
    }
    return dropTargetForElements({
      element: el,
      canDrop: ({ source }) => source.data["type"] === ENTITY_DRAG_TYPE,
      onDragEnter: () => setIsRootDropTarget(true),
      onDragLeave: () => setIsRootDropTarget(false),
      onDrop: ({ source }) => {
        setIsRootDropTarget(false);
        const entityIds = getDragEntityIds(source.data);
        if (!entityIds) {
          return;
        }
        for (const entityId of entityIds) {
          moveEntityRefRoot.current.mutate(
            { workspaceId, entityId, parentId: null },
            {
              onError: () => {
                stellaToast.add({
                  title: t("errors.actionFailed"),
                  type: "error",
                });
              },
            },
          );
        }
      },
    });
  }, [workspaceId, t]);

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
    // TODO: fix this
    // oxlint-disable-next-line jsx_a11y/no-static-element-interactions, jsx_a11y/click-events-have-key-events
    <div
      className="flex h-full flex-1 flex-col overflow-hidden p-2"
      onClick={(e) => {
        // Clear selection when clicking empty background
        // (not inside a row).
        if (
          e.target instanceof HTMLElement &&
          !e.target.closest("[data-entity-row]")
        ) {
          clearSelection();
        }
      }}
      onContextMenu={handleBgContextMenu}
    >
      <div className="mb-2 px-2">
        <div className="min-w-0">
          {currentFolderId && (
            <Breadcrumb>
              <BreadcrumbList>
                <BreadcrumbItem>
                  <button
                    className="text-muted-foreground hover:text-foreground text-xs"
                    onClick={() => {
                      void navigateToFolder();
                    }}
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
                        {(() => {
                          if (isEditingCrumb) {
                            return (
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
                            );
                          }
                          if (isLast) {
                            return (
                              <button
                                className="text-xs font-medium"
                                onClick={() => {
                                  void navigateToFolder();
                                }}
                                onDoubleClick={(e) => {
                                  e.stopPropagation();
                                  setBreadcrumbEditValue(crumb.name);
                                  setEditingEntityId(crumb.id);
                                }}
                                type="button"
                              >
                                {crumb.name}
                              </button>
                            );
                          }
                          return (
                            <button
                              className="text-muted-foreground hover:text-foreground text-xs"
                              onClick={() => {
                                void navigateToFolder(crumb.id);
                              }}
                              type="button"
                            >
                              {crumb.name}
                            </button>
                          );
                        })()}
                      </BreadcrumbItem>
                    </Fragment>
                  );
                })}
              </BreadcrumbList>
            </Breadcrumb>
          )}
        </div>
      </div>
      <div
        className={cn(
          "text-muted-foreground mt-1 flex items-center gap-2 rounded border border-dashed px-3 py-1.5 text-xs transition-colors",
          isDragActive ? "visible" : "hidden",
          isRootDropTarget
            ? "border-primary bg-primary/10 text-foreground"
            : "border-muted-foreground/30",
        )}
        ref={rootBarRef}
      >
        <FolderIcon className="size-3.5" />
        {t("workspaces.filesystem.moveToRoot")}
      </div>
      <div className="mt-1 min-h-0 flex-1 overflow-auto" ref={rowsViewportRef}>
        <div className="w-max min-w-full">
          <div
            className="text-muted-foreground bg-background sticky top-0 z-10 grid w-full items-center gap-x-4 border-b px-2 pb-1 text-xs font-medium"
            style={{ gridTemplateColumns: gridTemplate }}
          >
            <ColumnHeaderCell
              activeSort={primarySort}
              currentWidth={columnWidths[NAME_COL_ID]}
              label={t("common.name")}
              onResize={(width) => setColumnWidth(NAME_COL_ID, width)}
              onSort={handleSortColumn}
              propertyId={getInternalPropertyId("name")}
            />
            {extraColumns.map((col) => (
              <ColumnHeaderCell
                activeSort={primarySort}
                align="end"
                currentWidth={columnWidths[col.id] ?? DEFAULT_EXTRA_WIDTH_PX}
                key={col.id}
                label={col.label}
                onHide={() => handleHideColumn(col.id)}
                onResize={(width) => setColumnWidth(col.id, width)}
                onSort={handleSortColumn}
                propertyId={col.id}
              />
            ))}
            <span />
          </div>
          <div
            className="relative mt-1"
            style={{ height: rowVirtualizer.getTotalSize() }}
          >
            {virtualRows.map((virtualRow) => {
              const row = flattenedRows.at(virtualRow.index);
              if (!row) {
                return null;
              }

              return (
                <div
                  className="absolute inset-x-0 top-0 w-full"
                  data-index={virtualRow.index}
                  key={row.node.entityId}
                  style={{
                    height: virtualRow.size,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  <FilesystemRow
                    ancestorIds={row.ancestorIds}
                    currentFolderId={currentFolderId}
                    depth={row.depth}
                    editingEntityId={editingEntityId}
                    expandedIds={expandedIds}
                    extraColumns={extraColumns}
                    getSelectedDragItems={getSelectedDragItems}
                    getSelectedEntities={getSelectedEntities}
                    gridTemplate={gridTemplate}
                    guideDepths={row.guideDepths}
                    isLast={row.isLast}
                    node={row.node}
                    onNavigateToFolder={(folderId) => {
                      void navigateToFolder(folderId);
                    }}
                    onRename={(entityId, newName) => {
                      renameEntity.mutate({
                        workspaceId,
                        entityId,
                        name: newName,
                      });
                    }}
                    onSelect={handleSelect}
                    onStartEditing={setEditingEntityId}
                    onSubfolderCreated={handleSubfolderCreated}
                    onToggleFolder={toggleFolder}
                    selectedIds={selectedIds}
                    workspaceId={workspaceId}
                  />
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <div className="mt-2 shrink-0 px-2">
        <AddEntityMenu
          onFolderCreated={setEditingEntityId}
          parentId={currentFolderId}
          showTaskOption={false}
          workspaceId={workspaceId}
        />
      </div>
      {/* Background right-click context menu (same items as "+") */}
      <AddEntityMenu
        anchor={bgContextAnchor}
        onFolderCreated={handleFolderCreated}
        onOpenChange={(o) => {
          if (!o) {
            setBgContextAnchor(null);
          }
        }}
        open={isBgContextOpen}
        parentId={currentFolderId}
        showTaskOption={false}
        render={
          <button
            aria-label={t("common.add")}
            className="sr-only"
            tabIndex={-1}
            type="button"
          />
        }
        workspaceId={workspaceId}
      />
    </div>
  );
};

// -- Row --

type ColumnHeaderCellProps = {
  activeSort: WorkspaceView<"filesystem">["layout"]["sorts"][number] | null;
  currentWidth?: number | undefined;
  label: string;
  propertyId: string;
  onSort: (propertyId: string) => void;
  onResize: (width: number) => void;
  onHide?: (() => void) | undefined;
  align?: "start" | "end" | undefined;
};

const ColumnHeaderCell = ({
  activeSort,
  currentWidth,
  label,
  propertyId,
  onSort,
  onResize,
  onHide,
  align = "start",
}: ColumnHeaderCellProps) => {
  const t = useTranslations();
  const containerRef = useRef<HTMLDivElement>(null);
  const [contextAnchor, setContextAnchor] = useState<{
    getBoundingClientRect: () => DOMRect;
  } | null>(null);
  const isContextOpen = contextAnchor !== null;
  const isActive = activeSort?.propertyId === propertyId;
  const SortIcon = activeSort?.desc ? ArrowDownIcon : ArrowUpIcon;

  const handleResizePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const startX = event.clientX;
      const startWidth =
        currentWidth ??
        containerRef.current?.getBoundingClientRect().width ??
        0;
      const handleMove = (moveEvent: PointerEvent) => {
        moveEvent.preventDefault();
        const delta = moveEvent.clientX - startX;
        onResize(startWidth + delta);
      };
      const handleUp = () => {
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleUp);
        document.body.style.cursor = "";
      };
      document.body.style.cursor = "col-resize";
      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleUp);
    },
    [currentWidth, onResize],
  );

  const handleContextMenu = useCallback(
    (event: React.MouseEvent) => {
      if (!onHide) {
        return;
      }
      event.preventDefault();
      const x = event.clientX;
      const y = event.clientY;
      setContextAnchor({
        getBoundingClientRect: () => new DOMRect(x, y, 0, 0),
      });
    },
    [onHide],
  );

  return (
    <div
      className={cn(
        "group/column relative flex min-w-0 items-center",
        align === "end" ? "justify-end" : "justify-start",
      )}
      onContextMenu={handleContextMenu}
      ref={containerRef}
    >
      <button
        className={cn(
          "hover:text-foreground flex min-w-0 items-center gap-1 rounded-sm py-0.5 transition-colors",
          align === "end" ? "justify-end text-end" : "justify-start text-start",
          isActive && "text-foreground",
        )}
        onClick={() => onSort(propertyId)}
        type="button"
      >
        <span className="truncate">{label}</span>
        {isActive && <SortIcon className="size-3 shrink-0" />}
      </button>
      <div
        aria-hidden="true"
        className="absolute -end-2 top-0 z-10 h-full w-2 cursor-col-resize touch-none select-none"
        onPointerDown={handleResizePointerDown}
      >
        <div className="bg-border/0 group-hover/column:bg-border/60 hover:bg-primary/60 mx-auto h-full w-px transition-colors" />
      </div>
      {onHide && (
        <Menu
          onOpenChange={(open) => {
            if (!open) {
              setContextAnchor(null);
            }
          }}
          open={isContextOpen}
        >
          <MenuTrigger
            render={
              <button
                aria-label={t("common.options")}
                className="sr-only"
                tabIndex={-1}
                type="button"
              />
            }
          />
          <MenuPopup anchor={contextAnchor ?? undefined}>
            <MenuItem
              onClick={() => {
                onHide();
                setContextAnchor(null);
              }}
            >
              <EyeOffIcon className="size-4" />
              {t("workspaces.views.hideColumn")}
            </MenuItem>
          </MenuPopup>
        </Menu>
      )}
    </div>
  );
};

type FilesystemRowProps = {
  node: TableTreeNode;
  depth: number | undefined;
  guideDepths: number[];
  isLast: boolean;
  workspaceId: string;
  extraColumns: ExtraColumn[];
  gridTemplate: string;
  ancestorIds: Set<string>;
  expandedIds: Set<string>;
  selectedIds: Set<string>;
  editingEntityId: string | null;
  currentFolderId: string | undefined;
  onToggleFolder: (folderId: string) => void;
  onNavigateToFolder: (folderId: string) => void;
  onStartEditing: (entityId: string | null) => void;
  onRename: (entityId: string, newName: string) => void;
  onSelect: (entityId: string, meta: boolean) => void;
  onSubfolderCreated: (entityId: string, parentId: string) => void;
  getSelectedDragItems: (ids: Set<string>) => DragPreviewData[];
  getSelectedEntities: (ids: Set<string>) => WorkspaceEntity[];
};

const FilesystemRow = ({
  node,
  depth = 0,
  guideDepths,
  isLast,
  workspaceId,
  extraColumns,
  gridTemplate,
  ancestorIds,
  expandedIds,
  selectedIds,
  editingEntityId,
  currentFolderId,
  onToggleFolder,
  onNavigateToFolder,
  onStartEditing,
  onRename,
  onSelect,
  onSubfolderCreated,
  getSelectedDragItems,
  getSelectedEntities,
}: FilesystemRowProps) => {
  const t = useTranslations();
  // RowActions can open via two paths: a trigger-button click (anchors
  // the menu to the ellipsis button) or a right-click on the row (anchors
  // to the cursor position). Model both with a discriminated union so the
  // anchor and open state stay in sync.
  const [menuState, setMenuState] = useState<
    | { type: "closed" }
    | { type: "trigger" }
    | { type: "context"; anchor: { getBoundingClientRect: () => DOMRect } }
  >({ type: "closed" });
  const isContextOpen = menuState.type !== "closed";
  const contextAnchor =
    menuState.type === "context" ? menuState.anchor : undefined;
  const [editValue, setEditValue] = useState("");
  const isFolder = node.kind === "folder";
  const isEditing = editingEntityId === node.entityId;
  const isSelected = selectedIds.has(node.entityId);
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

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // If right-clicking an unselected item, select only it.
    if (!isSelected) {
      onSelect(node.entityId, false);
    }
    const x = e.clientX;
    const y = e.clientY;
    setMenuState({
      type: "context",
      anchor: {
        getBoundingClientRect: () => new DOMRect(x, y, 0, 0),
      },
    });
  };

  // Drag + drop support via pragmatic-drag-and-drop.
  const rowRef = useRef<HTMLDivElement>(null);

  useInspectorFlash(node.entityId, rowRef);

  const moveEntity = useMoveEntity();
  const [isDropTarget, setIsDropTarget] = useState(false);
  const autoExpandTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Store volatile values in refs so the effect doesn't
  // re-register drag/drop handlers on every render.
  // Re-registering mid-drag tears down the active drop target
  // and causes drops to silently fail.
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const ancestorIdsRef = useRef(ancestorIds);
  ancestorIdsRef.current = ancestorIds;
  const moveEntityRef = useRef(moveEntity);
  moveEntityRef.current = moveEntity;
  const onToggleFolderRef = useRef(onToggleFolder);
  onToggleFolderRef.current = onToggleFolder;
  const selectedIdsRef = useRef(selectedIds);
  selectedIdsRef.current = selectedIds;
  const getSelectedDragItemsRef = useRef(getSelectedDragItems);
  getSelectedDragItemsRef.current = getSelectedDragItems;
  const getSelectedEntitiesRef = useRef(getSelectedEntities);
  getSelectedEntitiesRef.current = getSelectedEntities;

  useEffect(() => {
    const el = rowRef.current;
    if (!el) {
      return undefined;
    }
    const cleanup = combine(
      draggable({
        element: el,
        getInitialData: () => {
          const sel = selectedIdsRef.current;
          const isMulti = sel.size > 1 && sel.has(node.entityId);
          // When the dragged item is part of a multi-selection,
          // include all selected entity IDs in the drag data.
          const entityIds = isMulti ? [...sel] : [node.entityId];
          // Include metadata for each entity so drop targets
          // (e.g. the chat panel) can create mentions for all.
          const entities = isMulti
            ? getSelectedEntitiesRef.current(sel).map((e) => ({
                entityId: e.entityId,
                name: getEntityName(e),
                kind: e.kind,
                mimeType: getFirstFile(e)?.mimeType ?? null,
                parentId: e.parentId ?? null,
              }))
            : [
                {
                  entityId: node.entityId,
                  name,
                  kind: node.kind,
                  mimeType: file?.mimeType ?? null,
                  parentId: node.parentId ?? null,
                },
              ];
          return {
            type: ENTITY_DRAG_TYPE,
            entityId: node.entityId,
            entityIds,
            entities,
            parentId: node.parentId ?? null,
            name,
            kind: node.kind,
            mimeType: file?.mimeType ?? null,
          };
        },
        onGenerateDragPreview: ({ nativeSetDragImage }) => {
          setCustomNativeDragPreview({
            nativeSetDragImage,
            render: ({ container }) => {
              const sel = selectedIdsRef.current;
              if (sel.size > 1 && sel.has(node.entityId)) {
                const items = getSelectedDragItemsRef.current(sel);
                return renderMultiDragPreview(container, items);
              }
              return renderDragPreview(container, {
                name,
                kind: node.kind,
                mimeType: file?.mimeType ?? null,
              });
            },
          });
        },
      }),
      // Only folders are drop targets.
      ...(isFolder
        ? [
            dropTargetForElements({
              element: el,
              canDrop: ({ source }) => {
                if (source.data["type"] !== ENTITY_DRAG_TYPE) {
                  return false;
                }

                const entityId = getDragEntityId(source.data);
                return (
                  entityId !== null &&
                  entityId !== node.entityId &&
                  !ancestorIdsRef.current.has(entityId)
                );
              },
              getData: () => ({ entityId: node.entityId }),
              onDragEnter: () => {
                setIsDropTarget(true);
                if (!expandedRef.current) {
                  autoExpandTimer.current = setTimeout(() => {
                    onToggleFolderRef.current(node.entityId);
                  }, 600);
                }
              },
              onDragLeave: () => {
                setIsDropTarget(false);
                if (autoExpandTimer.current) {
                  clearTimeout(autoExpandTimer.current);
                  autoExpandTimer.current = null;
                }
              },
              onDrop: ({ source }) => {
                setIsDropTarget(false);
                if (autoExpandTimer.current) {
                  clearTimeout(autoExpandTimer.current);
                  autoExpandTimer.current = null;
                }
                const entityIds = getDragEntityIds(source.data);
                if (!entityIds) {
                  return;
                }
                for (const entityId of entityIds) {
                  if (ancestorIdsRef.current.has(entityId)) {
                    continue;
                  }
                  if (entityId === node.entityId) {
                    continue;
                  }
                  moveEntityRef.current.mutate(
                    {
                      workspaceId,
                      entityId,
                      parentId: node.entityId,
                    },
                    {
                      onError: () => {
                        stellaToast.add({
                          title: t("errors.actionFailed"),
                          type: "error",
                        });
                      },
                    },
                  );
                }
              },
            }),
          ]
        : []),
    );
    return () => {
      cleanup();
      if (autoExpandTimer.current) {
        clearTimeout(autoExpandTimer.current);
        autoExpandTimer.current = null;
      }
    };
  }, [
    node.entityId,
    node.parentId,
    node.kind,
    name,
    file?.mimeType,
    isFolder,
    workspaceId,
    t,
  ]);

  // Shared cells: Name + Type
  const nameCell = (
    <span
      className="relative flex h-full min-w-0 items-center gap-1.5 self-stretch"
      style={{ paddingLeft: `${depth * FILESYSTEM_INDENT_PX}px` }}
    >
      <TreeGuideLines depth={depth} guideDepths={guideDepths} isLast={isLast} />
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
      {(() => {
        if (isFolder) {
          if (expanded) {
            return (
              <FolderOpenIcon className="text-muted-foreground size-4 shrink-0" />
            );
          }
          return (
            <FolderIcon className="text-muted-foreground size-4 shrink-0" />
          );
        }
        if (file?.mimeType) {
          return (
            <DocumentIcon
              className="size-4 shrink-0"
              mimeType={file.mimeType}
            />
          );
        }
        return <FileIcon className="text-muted-foreground size-4 shrink-0" />;
      })()}
      {isEditing ? (
        <InlineEdit
          inputClassName="w-48"
          onCancel={cancelEditing}
          onChange={setEditValue}
          onCommit={commitRename}
          suffix={
            ext ? (
              <span className="text-muted-foreground text-sm">{ext}</span>
            ) : undefined
          }
          value={editValue}
        />
      ) : (
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate" title={name}>
            {name}
          </span>
          {node.activeEditBy && (
            <ActiveEditBadge
              className="shrink-0"
              image={node.activeEditBy.image}
              name={node.activeEditBy.name}
            />
          )}
        </span>
      )}
    </span>
  );

  const extraCells = extraColumns.map((col) => (
    <span
      className="text-muted-foreground flex h-full min-w-0 items-center justify-end overflow-hidden text-end text-xs text-ellipsis whitespace-nowrap"
      key={col.id}
    >
      <ExtraColumnCell column={col} entity={node} />
    </span>
  ));

  const gridCls = cn(
    "hover:bg-muted grid h-full w-full items-center gap-x-4 rounded px-2 text-start text-sm",
    isDropTarget && "bg-accent ring-primary ring-2",
    isSelected && "bg-accent",
  );

  // Content area: Name + Type + extras (interactive, clickable)
  // gridColumn spans all content columns (excluding the actions column)
  const contentSpanStyle = {
    gridColumn: "1 / -2",
    display: "grid",
    gridTemplateColumns: gridTemplate.replace(ACTIONS_COL_RE, ""),
    alignItems: "center",
    alignSelf: "stretch",
    columnGap: "1rem",
  } as const;
  const contentCells = (
    <>
      {nameCell}
      {extraCells}
    </>
  );

  const isBulkSelected = selectedIds.size > 1 && isSelected;

  const openInInspector = (() => {
    if (isBulkSelected) {
      const entities = getSelectedEntities(selectedIds);
      const navigables: Omit<FileTab, "type">[] = [];
      for (const entity of entities) {
        const candidateFile = getFirstFile(entity);
        if (!candidateFile || !isFileDisplayable(candidateFile)) {
          continue;
        }

        navigables.push({
          id: candidateFile.fieldId,
          entityId: entity.entityId,
          label: getEntityName(entity),
          mimeType: candidateFile.mimeType,
          pdfFileId: candidateFile.pdfFileId,
          propertyId: candidateFile.propertyId,
          workspaceId,
        });
      }
      if (navigables.length === 0) {
        return undefined;
      }
      return () => {
        const store = useInspectorStore.getState();
        for (const tab of navigables) {
          store.openFile(tab);
        }
      };
    }
    if (node.kind === "task") {
      return () => useInspectorStore.getState().openTask(node.entityId, name);
    }
    if (navigable) {
      return () =>
        useInspectorStore.getState().openFile({
          id: file.fieldId,
          entityId: file.entityId,
          label: name,
          mimeType: file.mimeType,
          pdfFileId: file.pdfFileId,
          propertyId: file.propertyId,
          workspaceId,
        });
    }
    return undefined;
  })();

  // Capture bulk entities at context-menu-open time. Base UI's Menu
  // steals focus on open, which can trigger a click event that clears
  // selectedIds before RowActions re-renders. Using a ref preserves
  // the selection snapshot from when the menu was triggered.
  const bulkEntitiesRef = useRef<WorkspaceEntity[] | undefined>(undefined);
  if (isContextOpen && isBulkSelected) {
    bulkEntitiesRef.current = getSelectedEntities(selectedIds);
  } else if (!isContextOpen) {
    bulkEntitiesRef.current = undefined;
  }
  let bulkEntities: WorkspaceEntity[] | undefined;
  if (isContextOpen) {
    bulkEntities = bulkEntitiesRef.current;
  } else if (isBulkSelected) {
    bulkEntities = getSelectedEntities(selectedIds);
  }

  const rowActionsNode = (
    <span className="flex justify-end">
      <RowActions
        anchor={contextAnchor}
        entity={node}
        onOpen={openInInspector}
        onOpenChange={(o) => {
          if (!o) {
            setMenuState({ type: "closed" });
          } else if (menuState.type === "closed") {
            // Trigger-button click: Base UI positions the menu against
            // the trigger element, so no virtual anchor is needed.
            setMenuState({ type: "trigger" });
          }
        }}
        onRename={startEditing}
        onSubfolderCreated={onSubfolderCreated}
        open={isContextOpen}
        selectedEntities={bulkEntities}
        workspaceId={workspaceId}
      />
    </span>
  );

  return (
    <div
      className="group/row relative h-full"
      data-entity-row
      onContextMenu={handleContextMenu}
      ref={rowRef}
    >
      {isFolder ? (
        <div className={gridCls} style={{ gridTemplateColumns: gridTemplate }}>
          <button
            className="text-start"
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
          {rowActionsNode}
        </div>
      ) : (
        <div className={gridCls} style={{ gridTemplateColumns: gridTemplate }}>
          <button
            onClick={(e) => onSelect(node.entityId, e.metaKey || e.ctrlKey)}
            onDoubleClick={() => openInInspector?.()}
            style={contentSpanStyle}
            type="button"
          >
            {contentCells}
          </button>
          {rowActionsNode}
        </div>
      )}
    </div>
  );
};

type TreeGuideLinesProps = {
  depth: number;
  guideDepths: readonly number[];
  isLast: boolean;
};

const TreeGuideLines = ({
  depth,
  guideDepths,
  isLast,
}: TreeGuideLinesProps) => {
  if (depth === 0) {
    return null;
  }

  const currentLineLeft =
    depth * FILESYSTEM_INDENT_PX - FILESYSTEM_GUIDE_OFFSET_PX;
  // The immediate parent's column is the same x as this row's own
  // current line; rendering a full-height guide there would mask the
  // half-height "L" stop on the last child.
  const continuationGuideDepths = guideDepths.filter(
    (guideDepth) => guideDepth !== depth - 1,
  );

  return (
    <span aria-hidden="true" className="pointer-events-none absolute inset-y-0">
      {continuationGuideDepths.map((guideDepth) => (
        <span
          className={cn(
            FILESYSTEM_GUIDE_LINE_COLOR_CLASS,
            "absolute top-0 bottom-0 w-px",
          )}
          key={guideDepth}
          style={{
            left:
              guideDepth * FILESYSTEM_INDENT_PX + FILESYSTEM_GUIDE_OFFSET_PX,
          }}
        />
      ))}
      <span
        className={cn(
          FILESYSTEM_GUIDE_LINE_COLOR_CLASS,
          "absolute top-0 w-px",
          isLast ? "h-1/2" : "bottom-0",
        )}
        style={{ left: currentLineLeft }}
      />
      <span
        className={cn(
          FILESYSTEM_GUIDE_LINE_COLOR_CLASS,
          "absolute top-1/2 h-px w-2.5",
        )}
        style={{ left: currentLineLeft }}
      />
    </span>
  );
};

// -- Extra column cell renderer --

type ExtraColumnCellProps = {
  column: ExtraColumn;
  entity: WorkspaceEntity;
};

const formatDateValue = (
  value: string | Date | null | undefined,
  locale: string,
): string => {
  if (value === undefined || value === null) {
    return "";
  }
  return new Date(value).toLocaleDateString(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
};

const ExtraColumnCell = ({ column, entity }: ExtraColumnCellProps) => {
  const locale = useLocale();
  if (column.type === "metadata") {
    switch (column.id) {
      case FILESYSTEM_CREATED_BY_ID:
        return <AuthorCell entity={entity} />;
      case FILESYSTEM_UPDATED_AT_ID:
        return <LastUpdatedCell entity={entity} />;
      case FILESYSTEM_VERSION_ID:
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
    const formatted = formatDateValue(field.content.value, locale);
    return (
      <span className="text-muted-foreground truncate text-xs">
        {formatted || "-"}
      </span>
    );
  }

  const value = getFieldValue(field);

  return (
    <span className="text-muted-foreground truncate text-xs">
      {value || "-"}
    </span>
  );
};
