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
import { useInspectorFlash } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-inspector-flash";
import {
  getEntityName,
  getFirstFile,
} from "@/routes/_protected.workspaces/$workspaceId/-utils";

const KIND_COLORS: Record<string, string> = {
  // eslint-disable-next-line no-inline-style-colors/no-inline-style-colors -- dark: variant present; rule false positive
  document: "border-s-blue-400 dark:border-s-blue-600",
  folder: "border-s-neutral-400 dark:border-s-neutral-500",
  // eslint-disable-next-line no-inline-style-colors/no-inline-style-colors -- dark: variant present; rule false positive
  message: "border-s-green-400 dark:border-s-green-600",
};

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

/** CSS color values for year-view dots — reference semantic option tokens. */
export const KIND_DOT_COLORS: Record<string, string> = {
  document: "var(--option-blue)",
  folder: "var(--option-gray)",
  message: "var(--option-green)",
};

export const TASK_STATUS_DOT_COLORS: Record<string, string> = {
  open: "var(--option-gray)",
  in_progress: "var(--option-blue)",
  in_review: "var(--option-amber)",
  done: "var(--option-emerald)",
  cancelled: "var(--option-red)",
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

  useInspectorFlash(entity.entityId, dragRef);

  useEffect(() => {
    const el = dragRef.current;
    if (!el || !isEditable) {
      return undefined;
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
        pdfFileId: file.pdfFileId,
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
        "bg-card w-full rounded border border-s-2 px-1.5 py-0.5",
        "hover:bg-accent text-start text-xs",
        "truncate",
        isEditable && "cursor-grab active:cursor-grabbing",
        entity.kind === "task" && entity.status
          ? (TASK_STATUS_BORDER_COLORS[entity.status] ??
              "border-s-muted-foreground")
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
