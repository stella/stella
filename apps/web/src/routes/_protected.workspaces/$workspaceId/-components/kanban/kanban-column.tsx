import { useRef, useState } from "react";
import type { ChangeEvent } from "react";

import type { Edge } from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge";
import { useVirtualizer } from "@tanstack/react-virtual";
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

import type { OptionColor } from "@stll/api/types";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@stll/ui/alert-dialog";
import { Button } from "@stll/ui/button";
import {
  ColorPicker,
  ColorPickerContent,
  DEFAULT_PRESETS,
} from "@stll/ui/color-picker";
import { KanbanColumnHeader } from "@stll/ui/kanban";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@stll/ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "@stll/ui/popover";
import { containedEventHandler } from "@stll/ui/use-contained-handler";
import { cn } from "@stll/ui/utils";
import type {
  CalculationProperty,
  CalculationSelection,
} from "@stll/workspace-ui/calculations";
import {
  CalculationPicker,
  ColumnCalculation,
} from "@stll/workspace-ui/calculations";

import { InlineEdit } from "@/components/inline-edit";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useExternalFileDrop } from "@/hooks/use-external-file-drop";
import { useFormatter } from "@/i18n/formatting-context";
import { toSafeId } from "@/lib/safe-id";
import type {
  EntityKind,
  WorkspaceEntity,
  WorkspaceProperty,
} from "@/lib/types";
import { toCalculationValue } from "@/lib/workspaces/calculations";
import { KanbanCard } from "@/routes/_protected.workspaces/$workspaceId/-components/kanban/kanban-card";
import {
  useKanbanColumnDrag,
  useKanbanEntityDropTarget,
} from "@/routes/_protected.workspaces/$workspaceId/-components/kanban/use-kanban-drop-targets";
import { useWorkspaceCalculationLabels } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-workspace-calculation-labels";

const KANBAN_CARD_ESTIMATE_PX = 128;
const KANBAN_CARD_OVERSCAN = 8;

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
  hasMore?: boolean | undefined;
  isLoadingMore?: boolean | undefined;
  onLoadMore?: (() => void) | undefined;
  onReorderColumn?:
    | ((sourceValue: string, targetValue: string, edge: Edge | null) => void)
    | undefined;
  /** When true, the column footer shows "+ New todo" instead of file upload. */
  taskOnly?: boolean | undefined;
  /**
   * What the view shows in every column header, and how a reader changes it.
   * One object rather than three optional props: a selection list without a
   * change handler, or either without the properties to choose from, is not a
   * state this column can render.
   */
  calculations?: KanbanCalculations | undefined;
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
  hasMore,
  isLoadingMore,
  onLoadMore,
  onReorderColumn,
  taskOnly,
  calculations,
}: KanbanColumnProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const columnRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
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
  const cardVirtualizer = useVirtualizer({
    count: entities.length,
    estimateSize: () => KANBAN_CARD_ESTIMATE_PX,
    getItemKey: (index) => entities.at(index)?.entityId ?? index,
    getScrollElement: () => scrollRef.current,
    overscan: KANBAN_CARD_OVERSCAN,
  });
  const virtualCards = cardVirtualizer.getVirtualItems();
  const loadMoreSentinelRef = useRef<HTMLDivElement>(null);

  useExternalSyncEffect(() => {
    const sentinel = loadMoreSentinelRef.current;
    const scrollRoot = scrollRef.current;
    if (!hasMore || isLoadingMore || !onLoadMore || !sentinel || !scrollRoot) {
      return undefined;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          onLoadMore();
        }
      },
      { root: scrollRoot, rootMargin: "200px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [entities.length, hasMore, isLoadingMore, onLoadMore]);

  const isDraggable = columnValue !== null && onReorderColumn !== undefined;
  const isEntityDragOver = useKanbanEntityDropTarget({
    elementRef: scrollRef,
    name: title,
    onDrop,
  });
  const { closestEdge: closestColumnEdge, isDragging } = useKanbanColumnDrag({
    columnValue,
    dragHandleRef,
    elementRef: columnRef,
    name: title,
    reorderEnabled: isDraggable,
  });

  const { isDropTarget, isInnerActive } = useExternalFileDrop({
    externalRef: columnRef,
    enabled: !!onFileUpload,
    onDrop: (files) => onFileUpload?.(files),
  });
  const isFileDragOver = isDropTarget && !isInnerActive;

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

  const handleColorSelect = (value: string) => {
    onChangeColor?.(value);
  };

  return (
    <div
      className={cn(
        "group/column relative flex w-[300px] max-w-[320px] min-w-[280px] shrink-0 flex-col rounded-lg transition-[opacity,background-color,outline-color]",
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
      <KanbanColumnHeader
        actions={
          <KanbanColumnActions
            entityCount={entities.length}
            onChangeColor={onChangeColor}
            onDeleteAll={onDeleteAll}
            onHideColumn={onHideColumn}
            optionColor={optionColor}
            title={title}
          />
        }
        dragHandle={
          isDraggable ? (
            <div
              className="text-muted-foreground hover:text-foreground shrink-0 cursor-grab opacity-0 transition-opacity group-hover/column:opacity-100"
              ref={dragHandleRef}
            >
              <GripVerticalIcon className="size-3.5" />
            </div>
          ) : null
        }
        calculation={
          // Drawn whenever the view has something to show or something to
          // choose: a saved total is visible to a reader who cannot change it.
          calculations &&
          (calculations.selections.length > 0 ||
            (calculations.onChange && calculations.properties.length > 0)) ? (
            <ColumnCalculations
              calculations={calculations}
              entities={entities}
            />
          ) : null
        }
        meta={editing ? undefined : format.number(entities.length)}
        swatch={
          <KanbanColumnSwatch
            color={color}
            onSelect={handleColorSelect}
            optionColor={optionColor}
            showPicker={onChangeColor !== undefined}
          />
        }
        title={
          <KanbanColumnTitle
            editValue={editValue}
            editing={editing}
            onCancel={cancelEditing}
            onChange={setEditValue}
            onCommit={commitRename}
            onStartEditing={onRenameColumn ? startEditing : undefined}
            title={title}
          />
        }
      />
      <div
        className="flex-1 overflow-y-auto p-2"
        onContextMenu={containedEventHandler(handleContextMenu)}
        ref={scrollRef}
      >
        {isFileDragOver && (
          <div className="border-primary/40 bg-primary/5 text-muted-foreground mb-2 flex items-center gap-2 rounded-lg border border-dashed p-3 text-xs">
            <FileUpIcon className="text-primary/60 size-4 shrink-0" />
            {t("workspaces.dropToUploadFiles")}
          </div>
        )}
        <div
          className="relative"
          style={{ height: cardVirtualizer.getTotalSize() }}
        >
          {virtualCards.map((virtualCard) => {
            const entity = entities.at(virtualCard.index);
            if (!entity) {
              return null;
            }

            return (
              <div
                className="absolute inset-x-0 top-0 pb-2"
                data-index={virtualCard.index}
                key={entity.entityId}
                ref={cardVirtualizer.measureElement}
                style={{ transform: `translateY(${virtualCard.start}px)` }}
              >
                <KanbanCard
                  cardFields={cardFields}
                  entity={entity}
                  onRename={onRenameEntity}
                  properties={properties}
                  workspaceId={workspaceId}
                />
              </div>
            );
          })}
          <div
            className="absolute inset-x-0 bottom-0 h-px"
            ref={loadMoreSentinelRef}
          />
        </div>
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
          <MenuTrigger
            nativeButton={false}
            render={<span className="sr-only" />}
          />
          <MenuPopup anchor={ctxAnchor ?? undefined}>
            <MenuItem onClick={() => onCreate("task")}>
              <SquareCheckIcon />
              {t("tasks.newTask")}
            </MenuItem>
          </MenuPopup>
        </Menu>
      )}
      {taskOnly && onCreate ? (
        <div className="border-t p-2">
          <Button
            className="w-full gap-1"
            onClick={() => onCreate("task")}
            size="xs"
            variant="ghost"
          >
            <PlusIcon className="size-3" />
            {t("tasks.newTask")}
          </Button>
        </div>
      ) : (
        onFileUpload && (
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
        )
      )}
    </div>
  );
};

type KanbanColumnActionsProps = {
  entityCount: number;
  title: string;
  onChangeColor?: ((color: OptionColor) => void) | undefined;
  onDeleteAll?: (() => void) | undefined;
  onHideColumn?: (() => void) | undefined;
  optionColor?: OptionColor | undefined;
};

/** The canonical column menu shared by flat and subgrouped boards. */
export const KanbanColumnActions = ({
  entityCount,
  onChangeColor,
  onDeleteAll,
  onHideColumn,
  optionColor,
  title,
}: KanbanColumnActionsProps) => {
  const t = useTranslations();
  const hasActions = onChangeColor ?? onHideColumn ?? onDeleteAll;
  if (!hasActions) {
    return null;
  }

  const handleColorSelect = (value: string) => {
    // SAFETY: DEFAULT_PRESETS values match OptionColor names.
    onChangeColor?.(value);
  };

  return (
    <Menu>
      <MenuTrigger
        aria-label={t("common.actions")}
        render={<Button size="icon-xs" variant="ghost" />}
      >
        <EllipsisVerticalIcon />
      </MenuTrigger>
      <MenuPopup>
        {onChangeColor && (
          <Popover modal>
            <PopoverTrigger render={<MenuItem closeOnClick={false} />}>
              <PaletteIcon />
              {t("common.changeColor")}
            </PopoverTrigger>
            <PopoverPopup
              className="*:data-[slot=popover-viewport]:p-1!"
              side="right"
            >
              <ColorPickerContent
                columns={9}
                defaultExpanded={false}
                moreLabel={t("common.showMore")}
                onSelect={handleColorSelect}
                presets={DEFAULT_PRESETS}
                value={optionColor}
              />
            </PopoverPopup>
          </Popover>
        )}
        {onHideColumn && (
          <MenuItem onClick={onHideColumn}>
            <EyeOffIcon />
            {t("workspaces.kanban.hideColumn")}
          </MenuItem>
        )}
        {onDeleteAll && entityCount > 0 && (
          <AlertDialog>
            <AlertDialogTrigger
              render={<MenuItem closeOnClick={false} variant="destructive" />}
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
                    count: String(entityCount),
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
  );
};

type ColumnTitleProps = {
  title: string;
  editing: boolean;
  editValue: string;
  onChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  /** Omitted when the column's name is not the reader's to change. */
  onStartEditing?: (() => void) | undefined;
};

/**
 * The column's name: the editor while it is being renamed, a button when
 * renaming is offered, and plain text otherwise — a button that does nothing
 * is still a tab stop, and reaching it and pressing Enter would answer with
 * silence.
 */
export const KanbanColumnTitle = ({
  title,
  editing,
  editValue,
  onChange,
  onCommit,
  onCancel,
  onStartEditing,
}: ColumnTitleProps) => {
  if (editing) {
    return (
      <InlineEdit
        className="flex-1"
        inputClassName="flex-1 font-medium"
        onCancel={onCancel}
        onChange={onChange}
        onCommit={onCommit}
        value={editValue}
      />
    );
  }

  if (!onStartEditing) {
    return <span className="truncate text-sm font-medium">{title}</span>;
  }

  return (
    <button
      className="truncate text-start text-sm font-medium"
      onClick={onStartEditing}
      type="button"
    >
      {title}
    </button>
  );
};

type ColumnSwatchProps = {
  color?: string | undefined;
  optionColor?: OptionColor | undefined;
  showPicker: boolean;
  onSelect: (color: string) => void;
};

/** The column's colour dot, and the picker behind it when it is editable. */
export const KanbanColumnSwatch = ({
  color,
  optionColor,
  showPicker,
  onSelect,
}: ColumnSwatchProps) => {
  const t = useTranslations();

  if (color === undefined) {
    return null;
  }

  if (!showPicker) {
    return (
      <span
        className="size-2.5 rounded-full"
        style={{ backgroundColor: color }}
      />
    );
  }

  return (
    <ColorPicker
      moreLabel={t("common.showMore")}
      onSelect={onSelect}
      side="bottom"
      value={optionColor}
    >
      <button
        aria-label={t("common.changeColor")}
        className="shrink-0 cursor-pointer"
        type="button"
      >
        <span
          className="block size-2.5 rounded-full"
          style={{ backgroundColor: color }}
        />
      </button>
    </ColorPicker>
  );
};

/**
 * What a board's columns add up to, and how a reader changes it.
 *
 * `onChange` is optional because reading a total and choosing one are separate
 * rights: someone who may not edit the view still sees what its columns add up
 * to, and simply gets no picker.
 */
export type KanbanCalculations = {
  selections: readonly CalculationSelection[];
  properties: readonly CalculationProperty[];
  onChange?: ((next: CalculationSelection[]) => void) | undefined;
};

type ColumnCalculationsProps = {
  entities: WorkspaceEntity[];
  calculations: KanbanCalculations;
};

/**
 * What the column adds up to, plus the control that chooses it. The control
 * stays out of the way until the column is hovered or something inside it takes
 * focus, so the header reads as a heading rather than a toolbar.
 */
export const ColumnCalculations = ({
  entities,
  calculations: { selections, properties, onChange },
}: ColumnCalculationsProps) => {
  const labels = useWorkspaceCalculationLabels();

  return (
    <span className="flex min-w-0 shrink-0 items-center gap-1">
      {selections.map((selection) => (
        <ColumnCalculation
          key={selection.propertyId}
          kind={selection.kind}
          labels={labels}
          values={entities.map((entity) =>
            toCalculationValue(
              entity.fields[toSafeId<"property">(selection.propertyId)],
            ),
          )}
        />
      ))}
      {onChange && properties.length > 0 && (
        <span className="opacity-0 transition-opacity group-hover/column:opacity-100 focus-within:opacity-100">
          <CalculationPicker
            labels={labels}
            onChange={onChange}
            properties={properties}
            selections={selections}
          />
        </span>
      )}
    </span>
  );
};
