import { useRef } from "react";

import { draggable } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { centerUnderPointer } from "@atlaskit/pragmatic-drag-and-drop/element/center-under-pointer";
import { setCustomNativeDragPreview } from "@atlaskit/pragmatic-drag-and-drop/element/set-custom-native-drag-preview";
import { useTranslations } from "use-intl";

import { isTaskStatus } from "@stll/api-contract";
import type { TaskStatus } from "@stll/api-contract";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@stll/ui/tooltip";
import { containedHandler } from "@stll/ui/use-contained-handler";
import { cn } from "@stll/ui/utils";

import type { DragPreviewData } from "@/components/drag-preview";
import { renderDragPreview } from "@/components/drag-preview";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useLocale } from "@/i18n/formatting-context";
import { captureInvalidTaskOption } from "@/lib/task-option-telemetry";
import { ENTITY_DRAG_TYPE } from "@/lib/workspaces/drag-constants";
import type { CalendarTask } from "@/lib/workspaces/queries/calendar-tasks";
import { useInspectorFlash } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-inspector-flash";

const TASK_STATUS_BORDER_COLORS = {
  open: "border-s-muted-foreground",
  in_progress: "border-s-foreground-strong-muted",
  in_review: "border-s-warning",
  done: "border-s-success",
  cancelled: "border-s-destructive",
} as const satisfies Record<TaskStatus, string>;

type CalendarEntityChipProps = {
  entity: CalendarTask;
  isEditable: boolean;
  workspaceId: string;
};

export const CalendarEntityChip = ({
  entity,
  isEditable,
  workspaceId,
}: CalendarEntityChipProps) => {
  const t = useTranslations();
  const locale = useLocale();
  const name = entity.name || t("tasks.untitled");
  const openTask = useInspectorTabsStore((s) => s.openTask);
  const status = isTaskStatus(entity.status) ? entity.status : null;

  const dragRef = useRef<HTMLButtonElement>(null);

  useInspectorFlash(entity.taskId, dragRef);

  useExternalSyncEffect(() => {
    if (status === null) {
      captureInvalidTaskOption("status");
    }
  }, [status]);

  useExternalSyncEffect(() => {
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
    openTask({ taskId: entity.taskId, workspaceId, label: name });
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
        status === null
          ? TASK_STATUS_BORDER_COLORS.open
          : TASK_STATUS_BORDER_COLORS[status],
      )}
      // eslint-disable-next-line react/react-compiler -- containedHandler house pattern; dragRef is handed to the helper, not read for rendered output
      onClick={containedHandler(dragRef, handleClick)}
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
