import { useEffect, useRef, useState } from "react";

import { dropTargetForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { PlusIcon, SquareCheckIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuTrigger,
} from "@stella/ui/components/menu";
import { cn } from "@stella/ui/lib/utils";

import type { EntityKind, WorkspaceEntity } from "@/lib/types";
import { ENTITY_DRAG_TYPE } from "@/routes/_protected.workspaces/$workspaceId/-components/drag-constants";

import { CalendarEntityChip } from "./calendar-entity-chip";
import type { CalendarDay } from "./calendar-utils";
import { CurrentTimeIndicator } from "./current-time-indicator";

/** An entity placed on a specific date by a specific property. */
export type CalendarEntry = {
  entity: WorkspaceEntity;
  /** Which date property placed this entity on this date. */
  propertyId: string;
};

const MAX_VISIBLE_MONTH = 3;
const MAX_VISIBLE_WEEK = 20;

type CalendarDayCellProps = {
  day: CalendarDay;
  entries: CalendarEntry[];
  workspaceId: string;
  mode: "month" | "week";
  isEditable: boolean;
  onDrop: (entityId: string, kind: string) => void;
  onCreate: (kind: EntityKind) => void;
};

export const CalendarDayCell = ({
  day,
  entries,
  workspaceId,
  mode,
  isEditable,
  onDrop,
  onCreate,
}: CalendarDayCellProps) => {
  const t = useTranslations();
  const maxVisible = mode === "month" ? MAX_VISIBLE_MONTH : MAX_VISIBLE_WEEK;
  const visible = entries.slice(0, maxVisible);
  const overflow = entries.length - maxVisible;
  const [expanded, setExpanded] = useState(false);
  const displayEntries = expanded ? entries : visible;

  const dayNum = Number.parseInt(day.date.slice(8), 10);

  // Context menu state
  const [ctxOpen, setCtxOpen] = useState(false);
  const [ctxAnchor, setCtxAnchor] = useState<{
    getBoundingClientRect: () => DOMRect;
  } | null>(null);

  const handleContextMenu = (e: React.MouseEvent) => {
    if (!isEditable) {
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

  const dropRef = useRef<HTMLDivElement>(null);
  const [isDropTarget, setIsDropTarget] = useState(false);

  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;

  useEffect(() => {
    const el = dropRef.current;
    if (!el || !isEditable) {
      return;
    }
    return dropTargetForElements({
      element: el,
      canDrop: ({ source }) => source.data.type === ENTITY_DRAG_TYPE,
      onDragEnter: () => setIsDropTarget(true),
      onDragLeave: () => setIsDropTarget(false),
      onDrop: ({ source }) => {
        setIsDropTarget(false);
        const entityId = source.data.entityId;
        const kind = source.data.kind;
        if (typeof entityId === "string") {
          onDropRef.current(
            entityId,
            typeof kind === "string" ? kind : "document",
          );
        }
      },
    });
  }, [isEditable]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: context menu on day cell
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: context menu on day cell
    <div
      ref={dropRef}
      className={cn(
        "group/day relative flex flex-col gap-0.5",
        "overflow-hidden border-r border-b p-1",
        !day.isCurrentMonth && "bg-muted/30",
        day.isWeekend && day.isCurrentMonth && "bg-muted/15",
        mode === "week" && "min-h-[300px]",
        isDropTarget && "bg-primary/10",
      )}
      onContextMenu={handleContextMenu}
    >
      {/* Current time indicator (week view, today only) */}
      {mode === "week" && day.isToday && <CurrentTimeIndicator />}

      {/* Day number */}
      <div className="flex items-center justify-between">
        <span
          className={cn(
            "inline-flex size-6 items-center justify-center",
            "rounded-full text-xs",
            day.isToday && "bg-primary text-primary-foreground font-medium",
            !day.isCurrentMonth && "text-muted-foreground",
          )}
        >
          {dayNum}
        </span>
        {isEditable && (
          <Menu>
            <MenuTrigger
              render={
                <button
                  aria-label={t("common.add")}
                  className="text-muted-foreground hover:bg-accent hover:text-foreground inline-flex size-5 items-center justify-center rounded opacity-0 transition-opacity group-hover/day:opacity-100"
                  type="button"
                />
              }
            >
              <PlusIcon className="size-3.5" />
            </MenuTrigger>
            <MenuPopup>
              <MenuItem onClick={() => onCreate("task")}>
                <SquareCheckIcon />
                {t("tasks.newTask")}
              </MenuItem>
            </MenuPopup>
          </Menu>
        )}
      </div>

      {/* Entity cards */}
      <div className="flex flex-col gap-0.5">
        {displayEntries.map(({ entity, propertyId }) => (
          <CalendarEntityChip
            entity={entity}
            isEditable={isEditable}
            key={`${entity.entityId}-${propertyId}`}
            workspaceId={workspaceId}
          />
        ))}
      </div>

      {/* Overflow indicator */}
      {overflow > 0 && !expanded && (
        <button
          className="text-muted-foreground hover:text-foreground text-left text-xs"
          onClick={() => setExpanded(true)}
          type="button"
        >
          {t("workspaces.views.calendar.more", {
            count: String(overflow),
          })}
        </button>
      )}

      {/* Right-click context menu */}
      {isEditable && (
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
    </div>
  );
};
