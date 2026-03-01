import { useRef, useState, type ChangeEvent } from "react";
import {
  EllipsisVerticalIcon,
  EyeOffIcon,
  FileUpIcon,
  GripVerticalIcon,
  PaletteIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { useDrag, useDrop } from "react-aria";
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

import type { WorkspaceEntity, WorkspaceProperty } from "@/lib/types";
import { InlineEdit } from "@/routes/_protected.workspaces/$workspaceId/-components/inline-edit";
import { KanbanCard } from "@/routes/_protected.workspaces/$workspaceId/-components/kanban/kanban-card";
import { SelectColorIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/properties/shared";
import { optionColors } from "@/routes/_protected.workspaces/$workspaceId/-components/utils";

const ENTITY_DRAG_TYPE = "stella/entity-id";
const COLUMN_DRAG_TYPE = "stella/column-value";

type KanbanColumnProps = {
  title: string;
  columnValue: string | null;
  entities: WorkspaceEntity[];
  workspaceId: string;
  color?: string;
  colorBg?: string;
  optionColor?: OptionColor;
  cardFields?: string[];
  properties?: WorkspaceProperty[];
  onDrop: (entityId: string) => void;
  onFileUpload?: (files: File[]) => void;
  onChangeColor?: (color: OptionColor) => void;
  onRenameColumn?: (newName: string) => void;
  onRenameEntity?: (entityId: string, newName: string) => void;
  onHideColumn?: () => void;
  onDeleteAll?: () => void;
  onReorderColumn?: (sourceValue: string, targetValue: string) => void;
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
  onDeleteAll,
  onReorderColumn,
}: KanbanColumnProps) => {
  const t = useTranslations();
  const dropRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(title);
  const [isFileDragOver, setIsFileDragOver] = useState(false);
  const dragCounterRef = useRef(0);

  const isDraggable = columnValue !== null && onReorderColumn !== undefined;

  const { dragProps } = useDrag({
    getItems: () =>
      columnValue !== null ? [{ [COLUMN_DRAG_TYPE]: columnValue }] : [],
    isDisabled: !isDraggable,
  });

  // Native drag events detect OS file drags (dataTransfer has "Files")
  const handleNativeDragEnter = (e: React.DragEvent) => {
    dragCounterRef.current += 1;
    if (onFileUpload && e.dataTransfer.types.includes("Files")) {
      setIsFileDragOver(true);
    }
  };
  const handleNativeDragLeave = () => {
    dragCounterRef.current -= 1;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsFileDragOver(false);
    }
  };

  const { dropProps, isDropTarget } = useDrop({
    ref: dropRef,
    async onDrop(e) {
      dragCounterRef.current = 0;
      setIsFileDragOver(false);
      const files: File[] = [];
      for (const item of e.items) {
        if (item.kind === "text" && item.types.has(COLUMN_DRAG_TYPE)) {
          const sourceValue = await item.getText(COLUMN_DRAG_TYPE);
          if (columnValue !== null && sourceValue !== columnValue) {
            onReorderColumn?.(sourceValue, columnValue);
          }
        } else if (item.kind === "text" && item.types.has(ENTITY_DRAG_TYPE)) {
          const entityId = await item.getText(ENTITY_DRAG_TYPE);
          onDrop(entityId);
        } else if (item.kind === "file") {
          const file = await item.getFile();
          files.push(file);
        }
      }
      if (files.length > 0) {
        onFileUpload?.(files);
      }
    },
  });

  // Merge react-aria drop handlers with native file drag detection.
  // Spreading dropProps would override our explicit onDragEnter/Leave,
  // so we extract them and call both in merged handlers.
  const {
    onDragEnter: ariaOnDragEnter,
    onDragLeave: ariaOnDragLeave,
    ...restDropProps
  } = dropProps;

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) {
      return;
    }
    onFileUpload?.(Array.from(files));
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

  const hasColumnActions = onChangeColor || onHideColumn || onDeleteAll;

  return (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: drag-and-drop events from react-aria spread props
    // biome-ignore lint/a11y/noStaticElementInteractions: drag-and-drop container, not a clickable element
    <div
      className={cn(
        "group/column flex w-[300px] max-w-[320px] min-w-[280px] shrink-0 flex-col rounded-lg border-l-2 border-l-transparent transition-all",
        !colorBg && "bg-muted/50",
        isFileDragOver
          ? "bg-primary/5 ring-2 ring-primary/50"
          : isDropTarget && "border-l-primary bg-primary/5",
      )}
      onDragEnter={(e) => {
        ariaOnDragEnter?.(e);
        handleNativeDragEnter(e);
      }}
      onDragLeave={(e) => {
        ariaOnDragLeave?.(e);
        handleNativeDragLeave();
      }}
      ref={dropRef}
      style={
        colorBg
          ? {
              backgroundColor: `color-mix(in srgb, ${colorBg} 50%, transparent)`,
            }
          : undefined
      }
      {...restDropProps}
    >
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
              className="truncate text-left text-sm font-medium"
              onClick={startEditing}
              type="button"
            >
              {title}
            </button>
            <span className="text-xs text-muted-foreground">
              {entities.length}
            </span>
          </span>
        )}
        {isDraggable && (
          <div
            className="shrink-0 cursor-grab text-muted-foreground opacity-0 transition-opacity group-hover/column:opacity-100 hover:text-foreground"
            ref={dragRef}
            {...dragProps}
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
      <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-2">
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
          <div className="flex items-center gap-2 rounded-lg border border-dashed border-primary/40 bg-primary/5 p-3 text-xs text-muted-foreground">
            <FileUpIcon className="size-4 shrink-0 text-primary/60" />
            {t("workspaces.dropToUploadFiles")}
          </div>
        )}
      </div>
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
