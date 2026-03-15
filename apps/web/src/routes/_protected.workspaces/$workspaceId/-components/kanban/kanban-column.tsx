import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";

import {
  attachClosestEdge,
  extractClosestEdge,
} from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge";
import type { Edge } from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge";
import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import {
  draggable,
  dropTargetForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { dropTargetForExternal } from "@atlaskit/pragmatic-drag-and-drop/external/adapter";
import {
  containsFiles,
  getFiles,
} from "@atlaskit/pragmatic-drag-and-drop/external/file";
import {
  EllipsisVerticalIcon,
  EyeOffIcon,
  FileUpIcon,
  GripVerticalIcon,
  PaletteIcon,
  PlusIcon,
  SquareCheckIcon,
  Trash2Icon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import type { OptionColor } from "@stella/api/types";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@stella/ui/components/alert-dialog";
import { Button } from "@stella/ui/components/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuTrigger,
} from "@stella/ui/components/menu";
import {
  Popover,
  PopoverClose,
  PopoverPopup,
  PopoverTrigger,
} from "@stella/ui/components/popover";
import { cn } from "@stella/ui/lib/utils";

import type {
  EntityKind,
  WorkspaceEntity,
  WorkspaceProperty,
} from "@/lib/types";
import {
  COLUMN_DRAG_TYPE,
  ENTITY_DRAG_TYPE,
} from "@/routes/_protected.workspaces/$workspaceId/-components/drag-constants";
import { InlineEdit } from "@/routes/_protected.workspaces/$workspaceId/-components/inline-edit";
import { KanbanCard } from "@/routes/_protected.workspaces/$workspaceId/-components/kanban/kanban-card";
import { SelectColorIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/properties/shared";
import { optionColors } from "@/routes/_protected.workspaces/$workspaceId/-components/utils";

type KanbanColumnProps = {
  title: string;
  columnValue: string | null;
  entities: WorkspaceEntity[];
  workspaceId: string;
  color?: string | undefined;
  colorBg?: string | undefined;
  optionColor?: OptionColor | undefined;
  cardFields?: string[] | undefined;
  properties?: WorkspaceProperty[] | undefined;
  onDrop: (entityId: string) => void;
  onFileUpload?: ((files: File[]) => void) | undefined;
  onChangeColor?: ((color: OptionColor) => void) | undefined;
  onRenameColumn?: ((newName: string) => void) | undefined;
  onRenameEntity?: ((entityId: string, newName: string) => void) | undefined;
  onHideColumn?: (() => void) | undefined;
  onCreate?: ((kind: EntityKind) => void) | undefined;
  onDeleteAll?: (() => void) | undefined;
  onReorderColumn?:
    | ((sourceValue: string, targetValue: string, edge: Edge | null) => void)
    | undefined;
};

export const KanbanColumn = ({
  title,
  columnValue,
  entities,
  workspaceId,
  color,
  colorBg,
  optionColor,
  cardFields,
  properties,
  onDrop,
  onFileUpload,
  onChangeColor,
  onRenameColumn,
  onRenameEntity,
  onHideColumn,
  onCreate,
  onDeleteAll,
  onReorderColumn,
}: KanbanColumnProps) => {
  const t = useTranslations();
  const columnRef = useRef<HTMLDivElement>(null);
  const dragHandleRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(title);

  // Context menu state
  const [ctxOpen, setCtxOpen] = useState(false);
  const [ctxAnchor, setCtxAnchor] = useState<{
    getBoundingClientRect: () => DOMRect;
  } | null>(null);

  const handleContextMenu = (e: React.MouseEvent) => {
    if (!onCreate) {
      return;
    }
    e.preventDefault();
    const x = e.clientX;
    const y = e.clientY;
    setCtxAnchor({
      getBoundingClientRect: () => new DOMRect(x, y, 0, 0),
    });
    setCtxOpen(true);
  };
  const [isFileDragOver, setIsFileDragOver] = useState(false);
  const [isEntityDragOver, setIsEntityDragOver] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [closestColumnEdge, setClosestColumnEdge] = useState<Edge | null>(null);

  const isDraggable = columnValue !== null && onReorderColumn !== undefined;

  // Store callbacks in refs to keep effect deps stable.
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;
  const onFileUploadRef = useRef(onFileUpload);
  onFileUploadRef.current = onFileUpload;

  useEffect(() => {
    const el = columnRef.current;
    const handle = dragHandleRef.current;
    if (!el) {
      return;
    }

    const cleanups = [
      // Drop target for entity cards and column reorder
      dropTargetForElements({
        element: el,
        canDrop: ({ source }) =>
          source.data.type === ENTITY_DRAG_TYPE ||
          source.data.type === COLUMN_DRAG_TYPE,
        getData: ({ input, element, source }) => {
          const data: Record<string | symbol, unknown> = {
            columnValue,
          };
          if (source.data.type === COLUMN_DRAG_TYPE) {
            return attachClosestEdge(data, {
              input,
              element,
              allowedEdges: ["left", "right"],
            });
          }
          return data;
        },
        onDragEnter: ({ source, self }) => {
          if (source.data.type === ENTITY_DRAG_TYPE) {
            setIsEntityDragOver(true);
          } else if (source.data.type === COLUMN_DRAG_TYPE) {
            const sourceVal = source.data.columnValue;
            if (sourceVal !== columnValue) {
              setClosestColumnEdge(extractClosestEdge(self.data));
            }
          }
        },
        onDrag: ({ source, self }) => {
          if (source.data.type === COLUMN_DRAG_TYPE) {
            const sourceVal = source.data.columnValue;
            if (sourceVal === columnValue) {
              return;
            }
            const edge = extractClosestEdge(self.data);
            setClosestColumnEdge((prev) => (prev === edge ? prev : edge));
          }
        },
        onDragLeave: ({ source }) => {
          if (source.data.type === ENTITY_DRAG_TYPE) {
            setIsEntityDragOver(false);
          } else if (source.data.type === COLUMN_DRAG_TYPE) {
            setClosestColumnEdge(null);
          }
        },
        onDrop: ({ source }) => {
          setIsEntityDragOver(false);
          setClosestColumnEdge(null);
          // Column reorder is handled by the board-level
          // monitor (forgiving: works even if dropped in gap).
          if (source.data.type === ENTITY_DRAG_TYPE) {
            // SAFETY: entityId is always a string; set by our own draggable getInitialData.
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion
            const entityId = source.data.entityId as string;
            onDropRef.current(entityId);
          }
        },
      }),
    ];

    // External file drop target
    if (onFileUploadRef.current) {
      cleanups.push(
        dropTargetForExternal({
          element: el,
          canDrop: containsFiles,
          onDragEnter: () => setIsFileDragOver(true),
          onDragLeave: () => setIsFileDragOver(false),
          onDrop: ({ source }) => {
            setIsFileDragOver(false);
            const files = getFiles({ source });
            if (files.length > 0) {
              onFileUploadRef.current?.(files);
            }
          },
        }),
      );
    }

    // Column draggable: entire column is the element,
    // grip icon is the drag handle (Trello-style).
    if (isDraggable && handle && columnValue !== null) {
      cleanups.push(
        draggable({
          element: el,
          dragHandle: handle,
          getInitialData: () => ({
            type: COLUMN_DRAG_TYPE,
            columnValue,
          }),
          onDragStart: () => setIsDragging(true),
          onDrop: () => setIsDragging(false),
        }),
      );
    }

    return combine(...cleanups);
  }, [columnValue, isDraggable]);

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) {
      return;
    }
    onFileUpload?.([...files]);
    e.target.value = "";
  };

  const startEditing = () => {
    if (!onRenameColumn) {
      return;
    }
    setEditValue(title);
    setEditing(true);
  };

  const commitRename = () => {
    setEditing(false);
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== title) {
      onRenameColumn?.(trimmed);
    }
  };

  const cancelEditing = () => {
    setEditing(false);
    setEditValue(title);
  };

  const colorPickerGrid = (
    <div className="grid grid-cols-8 gap-0.5">
      {optionColors.map((c) => (
        <PopoverClose
          key={c}
          render={
            <Button
              data-pressed={c === optionColor ? true : undefined}
              onClick={() => onChangeColor?.(c)}
              size="icon-sm"
              type="button"
              variant="ghost"
            />
          }
        >
          <SelectColorIcon color={c} />
        </PopoverClose>
      ))}
    </div>
  );

  const hasColumnActions = onChangeColor ?? onHideColumn ?? onDeleteAll;

  return (
    <div
      className={cn(
        "group/column relative flex w-[300px] max-w-[320px] min-w-[280px] shrink-0 flex-col rounded-lg transition-all",
        !colorBg && "bg-muted/50",
        (isFileDragOver || isEntityDragOver) &&
          "bg-primary/5 ring-primary/50 ring-2",
        isDragging && "opacity-40",
      )}
      ref={columnRef}
      style={
        colorBg
          ? {
              backgroundColor: `color-mix(in srgb, ${colorBg} 50%, transparent)`,
            }
          : undefined
      }
    >
      {closestColumnEdge && !isDragging && (
        <div
          className={cn(
            "bg-primary pointer-events-none absolute top-0 z-10 flex h-full w-0.5 flex-col items-center",
            closestColumnEdge === "left" ? "-left-[9px]" : "-right-[9px]",
          )}
        >
          <div className="bg-primary -mt-0.5 size-2 rounded-full" />
        </div>
      )}
      <div className="flex items-center gap-2 px-3 py-2">
        {color && onChangeColor ? (
          <Popover modal>
            <PopoverTrigger
              render={
                <button className="shrink-0 cursor-pointer" type="button" />
              }
            >
              <span
                className="block size-2.5 rounded-full"
                style={{ backgroundColor: color }}
              />
            </PopoverTrigger>
            <PopoverPopup
              className="*:data-[slot=popover-viewport]:p-1!"
              side="bottom"
            >
              {colorPickerGrid}
            </PopoverPopup>
          </Popover>
        ) : color ? (
          <span
            className="size-2.5 rounded-full"
            style={{ backgroundColor: color }}
          />
        ) : null}
        {editing ? (
          <InlineEdit
            className="flex-1"
            inputClassName="flex-1 font-medium"
            onChange={setEditValue}
            onCancel={cancelEditing}
            onCommit={commitRename}
            value={editValue}
          />
        ) : (
          <span className="flex flex-1 items-center gap-1.5 truncate">
            <button
              className="truncate text-start text-sm font-medium"
              onClick={startEditing}
              type="button"
            >
              {title}
            </button>
            <span className="text-muted-foreground text-xs">
              {entities.length}
            </span>
          </span>
        )}
        {isDraggable && (
          <div
            className="text-muted-foreground hover:text-foreground shrink-0 cursor-grab opacity-0 transition-opacity group-hover/column:opacity-100"
            ref={dragHandleRef}
          >
            <GripVerticalIcon className="size-3.5" />
          </div>
        )}
        {hasColumnActions && (
          <Menu>
            <MenuTrigger render={<Button size="icon-xs" variant="ghost" />}>
              <EllipsisVerticalIcon />
            </MenuTrigger>
            <MenuPopup>
              {onChangeColor && (
                <Popover modal>
                  <PopoverTrigger render={<MenuItem closeOnClick={false} />}>
                    <PaletteIcon />
                    {t("workspaces.kanban.changeColor")}
                  </PopoverTrigger>
                  <PopoverPopup
                    className="*:data-[slot=popover-viewport]:p-1!"
                    side="right"
                  >
                    {colorPickerGrid}
                  </PopoverPopup>
                </Popover>
              )}
              {onHideColumn && (
                <MenuItem onClick={onHideColumn}>
                  <EyeOffIcon />
                  {t("workspaces.kanban.hideColumn")}
                </MenuItem>
              )}
              {onDeleteAll && entities.length > 0 && (
                <AlertDialog>
                  <AlertDialogTrigger
                    render={
                      <MenuItem closeOnClick={false} variant="destructive" />
                    }
                  >
                    <Trash2Icon />
                    {t("workspaces.kanban.deleteAll")}
                  </AlertDialogTrigger>
                  <AlertDialogPopup>
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        {t("workspaces.kanban.deleteAll")}
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        {t("workspaces.kanban.deleteAllConfirm", {
                          count: String(entities.length),
                          column: title,
                        })}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogClose render={<Button variant="ghost" />}>
                        {t("common.cancel")}
                      </AlertDialogClose>
                      <AlertDialogClose
                        render={
                          <Button onClick={onDeleteAll} variant="destructive" />
                        }
                      >
                        {t("workspaces.kanban.deleteAll")}
                      </AlertDialogClose>
                    </AlertDialogFooter>
                  </AlertDialogPopup>
                </AlertDialog>
              )}
            </MenuPopup>
          </Menu>
        )}
      </div>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: context menu on column body */}
      {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: context menu on column body */}
      <div
        className="flex flex-1 flex-col gap-2 overflow-y-auto p-2"
        onContextMenu={handleContextMenu}
      >
        {entities.map((entity) => (
          <KanbanCard
            cardFields={cardFields}
            entity={entity}
            key={entity.entityId}
            onRename={onRenameEntity}
            properties={properties}
            workspaceId={workspaceId}
          />
        ))}
        {isFileDragOver && (
          <div className="border-primary/40 bg-primary/5 text-muted-foreground flex items-center gap-2 rounded-lg border border-dashed p-3 text-xs">
            <FileUpIcon className="text-primary/60 size-4 shrink-0" />
            {t("workspaces.dropToUploadFiles")}
          </div>
        )}
      </div>
      {onCreate && (
        <Menu
          onOpenChange={(o) => {
            setCtxOpen(o);
            if (!o) {
              setCtxAnchor(null);
            }
          }}
          open={ctxOpen}
        >
          <MenuTrigger render={<span className="sr-only" />} />
          <MenuPopup anchor={ctxAnchor ?? undefined}>
            <MenuItem onClick={() => onCreate("task")}>
              <SquareCheckIcon />
              {t("tasks.newTask")}
            </MenuItem>
          </MenuPopup>
        </Menu>
      )}
      {onFileUpload && (
        <div className="border-t p-2">
          <input
            accept="*/*"
            className="hidden"
            multiple
            onChange={handleFileChange}
            ref={fileInputRef}
            type="file"
          />
          <Button
            className="w-full gap-1"
            onClick={() => fileInputRef.current?.click()}
            size="xs"
            variant="ghost"
          >
            <PlusIcon className="size-3" />
            {t("workspaces.kanban.uploadDocument")}
          </Button>
        </div>
      )}
    </div>
  );
};
