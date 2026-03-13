import { useEffect, useRef } from "react";

import { draggable } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { centerUnderPointer } from "@atlaskit/pragmatic-drag-and-drop/element/center-under-pointer";
import { setCustomNativeDragPreview } from "@atlaskit/pragmatic-drag-and-drop/element/set-custom-native-drag-preview";
import { useLocale, useTranslations } from "use-intl";

import {
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
} from "@stella/ui/components/tooltip";
import { cn } from "@stella/ui/lib/utils";

import type { DragPreviewData } from "@/components/drag-preview";
import { renderDragPreview } from "@/components/drag-preview";
import type { WorkspaceEntity } from "@/lib/types";
import { ENTITY_DRAG_TYPE } from "@/routes/_protected.workspaces/$workspaceId/-components/drag-constants";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import {
  getEntityName,
  getFirstFile,
} from "@/routes/_protected.workspaces/$workspaceId/-utils";

const KIND_COLORS: Record<string, string> = {
  document: "border-l-blue-400 dark:border-l-blue-600",
  folder: "border-l-neutral-400 dark:border-l-neutral-500",
  message: "border-l-green-400 dark:border-l-green-600",
};

const TASK_STATUS_BORDER_COLORS: Record<string, string> = {
  open: "border-l-muted-foreground",
  in_progress: "border-l-blue-500",
  in_review: "border-l-amber-500",
  done: "border-l-green-500",
  cancelled: "border-l-red-400",
};

/** CSS color values for year-view dots (not tailwind classes). */
export const KIND_DOT_COLORS: Record<string, string> = {
  document: "#60a5fa",
  folder: "#a3a3a3",
  message: "#4ade80",
};

export const TASK_STATUS_DOT_COLORS: Record<string, string> = {
  open: "#a3a3a3",
  in_progress: "#3b82f6",
  in_review: "#f59e0b",
  done: "#22c55e",
  cancelled: "#f87171",
};

type CalendarEntityChipProps = {
  entity: WorkspaceEntity;
  workspaceId: string;
  isEditable: boolean;
};

export const CalendarEntityChip = ({
  entity,
  isEditable,
  workspaceId,
}: CalendarEntityChipProps) => {
  const t = useTranslations();
  const locale = useLocale();
  const name = getEntityName(entity);
  const openPdf = useInspectorStore((s) => s.openPdf);
  const openTask = useInspectorStore((s) => s.openTask);
  const file = getFirstFile(entity);

  const dragRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const el = dragRef.current;
    if (!el || !isEditable) {
      return;
    }
    return draggable({
      element: el,
      getInitialData: () => ({
        type: ENTITY_DRAG_TYPE,
        entityId: entity.entityId,
        name,
        kind: entity.kind,
        mimeType: file?.mimeType ?? null,
      }),
      onGenerateDragPreview: ({ nativeSetDragImage }) => {
        setCustomNativeDragPreview({
          nativeSetDragImage,
          getOffset: centerUnderPointer,
          render: ({ container }) => {
            const data: DragPreviewData = {
              name,
              kind: entity.kind,
              mimeType: file?.mimeType ?? null,
            };
            renderDragPreview(container, data);
          },
        });
      },
    });
  }, [entity.entityId, entity.kind, isEditable, name, file?.mimeType]);

  const handleClick = () => {
    if (entity.kind === "task") {
      openTask(entity.entityId, name);
      return;
    }
    if (file) {
      openPdf({
        id: file.fieldId,
        entityId: entity.entityId,
        label: name,
        mimeType: file.mimeType,
        workspaceId,
      });
    }
  };

  const createdLabel = new Date(entity.createdAt).toLocaleDateString(locale, {
    dateStyle: "medium",
    timeZone: "UTC",
  });

  const card = (
    <button
      ref={dragRef}
      className={cn(
        "bg-card w-full rounded border border-l-2 px-1.5 py-0.5",
        "hover:bg-accent text-left text-xs",
        "truncate",
        isEditable && "cursor-grab active:cursor-grabbing",
        entity.kind === "task" && entity.status
          ? (TASK_STATUS_BORDER_COLORS[entity.status] ??
              "border-l-muted-foreground")
          : KIND_COLORS[entity.kind],
      )}
      onClick={handleClick}
      type="button"
    >
      {name}
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
