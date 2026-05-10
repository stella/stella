import { useEffect, useRef } from "react";

import { draggable } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { centerUnderPointer } from "@atlaskit/pragmatic-drag-and-drop/element/center-under-pointer";
import { setCustomNativeDragPreview } from "@atlaskit/pragmatic-drag-and-drop/element/set-custom-native-drag-preview";
import { useLocale, useTranslations } from "use-intl";

import {
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
} from "@stll/ui/components/tooltip";
import { cn } from "@stll/ui/lib/utils";

import type { DragPreviewData } from "@/components/drag-preview";
import { renderDragPreview } from "@/components/drag-preview";
import { ENTITY_DRAG_TYPE } from "@/routes/_protected.workspaces/$workspaceId/-components/drag-constants";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import { useInspectorFlash } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-inspector-flash";
import type { CalendarTask } from "@/routes/_protected.workspaces/$workspaceId/-queries/calendar-tasks";

const TASK_STATUS_BORDER_COLORS: Record<string, string> = {
  open: "border-s-muted-foreground",
  // eslint-disable-next-line no-inline-style-colors/no-inline-style-colors -- dark: variant present; rule false positive
  in_progress: "border-s-blue-500 dark:border-s-blue-400",
  in_review: "border-s-amber-500",
  // eslint-disable-next-line no-inline-style-colors/no-inline-style-colors -- dark: variant present; rule false positive
  done: "border-s-green-500 dark:border-s-green-400",
  // eslint-disable-next-line no-inline-style-colors/no-inline-style-colors -- dark: variant present; rule false positive
  cancelled: "border-s-red-400 dark:border-s-red-300",
};

export const TASK_STATUS_DOT_COLORS: Record<string, string> = {
  open: "var(--option-gray)",
  in_progress: "var(--option-blue)",
  in_review: "var(--option-amber)",
  done: "var(--option-emerald)",
  cancelled: "var(--option-red)",
};

type CalendarEntityChipProps = {
  entity: CalendarTask;
  isEditable: boolean;
};

export const CalendarEntityChip = ({
  entity,
  isEditable,
}: CalendarEntityChipProps) => {
  const t = useTranslations();
  const locale = useLocale();
  const name = entity.name || t("tasks.untitled");
  const openTask = useInspectorStore((s) => s.openTask);

  const dragRef = useRef<HTMLButtonElement>(null);

  useInspectorFlash(entity.taskId, dragRef);

  useEffect(() => {
    const el = dragRef.current;
    if (!el || !isEditable) {
      return undefined;
    }
    return draggable({
      element: el,
      getInitialData: () => ({
        type: ENTITY_DRAG_TYPE,
        entityId: entity.taskId,
        name,
        kind: "task",
        mimeType: null,
      }),
      onGenerateDragPreview: ({ nativeSetDragImage }) => {
        setCustomNativeDragPreview({
          nativeSetDragImage,
          getOffset: centerUnderPointer,
          render: ({ container }) => {
            const data: DragPreviewData = {
              name,
              kind: "task",
              mimeType: null,
            };
            renderDragPreview(container, data);
          },
        });
      },
    });
  }, [entity.taskId, isEditable, name]);

  const handleClick = () => {
    openTask(entity.taskId, name);
  };

  const createdLabel = new Date(entity.createdAt).toLocaleDateString(locale, {
    dateStyle: "medium",
    timeZone: "UTC",
  });

  const card = (
    <button
      ref={dragRef}
      className={cn(
        "bg-card w-full rounded border border-s-2 px-1.5 py-0.5",
        "hover:bg-accent text-start text-xs",
        "truncate",
        isEditable && "cursor-grab active:cursor-grabbing",
        entity.status
          ? (TASK_STATUS_BORDER_COLORS[entity.status] ??
              "border-s-muted-foreground")
          : "border-s-muted-foreground",
      )}
      onClick={handleClick}
      type="button"
    >
      <span className="flex min-w-0 items-center gap-1">
        <span className="truncate">{name}</span>
      </span>
    </button>
  );

  return (
    <Tooltip>
      <TooltipTrigger render={<span className="w-full" />}>
        {card}
      </TooltipTrigger>
      <TooltipPopup side="top">
        <div className="flex flex-col gap-0.5 py-0.5">
          <span className="font-medium">{name}</span>
          <span className="text-muted-foreground">
            {t("workspaces.views.calendar.createdAt")}: {createdLabel}
          </span>
        </div>
      </TooltipPopup>
    </Tooltip>
  );
};
