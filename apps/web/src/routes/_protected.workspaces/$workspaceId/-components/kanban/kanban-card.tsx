import { useRef } from "react";

import { draggable } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { centerUnderPointer } from "@atlaskit/pragmatic-drag-and-drop/element/center-under-pointer";
import { setCustomNativeDragPreview } from "@atlaskit/pragmatic-drag-and-drop/element/set-custom-native-drag-preview";
import { CalendarIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@stll/ui/components/avatar";
import { containedHandler } from "@stll/ui/hooks/use-contained-handler";
import { cn } from "@stll/ui/lib/utils";

import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useInlineRename } from "@/hooks/use-inline-rename";
import { useFormatter } from "@/i18n/formatting-context";
import { normalizeOptionalArray } from "@/lib/arrays";
import { toSafeId } from "@/lib/safe-id";
import { isFileDisplayable } from "@/lib/types";
import type {
  WorkspaceEntity,
  WorkspaceFieldContent,
  WorkspaceProperty,
} from "@/lib/types";
import { ActiveEditBadge } from "@/routes/_protected.workspaces/$workspaceId/-components/active-edit-badge";
import { useCellMetadataFlags } from "@/routes/_protected.workspaces/$workspaceId/-components/cell-metadata-flags";
import { ENTITY_DRAG_TYPE } from "@/routes/_protected.workspaces/$workspaceId/-components/drag-constants";
import { EditableField } from "@/routes/_protected.workspaces/$workspaceId/-components/editable-field";
import { EntityKindIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/entity-kind-icon";
import { InlineEdit } from "@/routes/_protected.workspaces/$workspaceId/-components/inline-edit";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import {
  getKanbanCardMetadataVisibility,
  getKanbanCardRenameInitialValue,
} from "@/routes/_protected.workspaces/$workspaceId/-components/kanban/kanban-card.logic";
import { RowActions } from "@/routes/_protected.workspaces/$workspaceId/-components/row-actions";
import { TaskBadges } from "@/routes/_protected.workspaces/$workspaceId/-components/tasks/task-badges";
import {
  isTaskPriority,
  isTaskStatus,
  PRIORITY_COLORS,
  PRIORITY_ICONS,
  STATUS_COLORS,
  STATUS_ICONS,
} from "@/routes/_protected.workspaces/$workspaceId/-components/tasks/task-detail-constants";
import { useInspectorFlash } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-inspector-flash";
import {
  formatRelativeTime,
  getEntityName,
  getFirstFile,
  getInternalPropertyId,
} from "@/routes/_protected.workspaces/$workspaceId/-utils";

type KanbanCardProps = {
  entity: WorkspaceEntity;
  workspaceId: string;
  cardFields?: string[] | undefined;
  properties?: WorkspaceProperty[] | undefined;
  onRename?: ((entityId: string, newName: string) => void) | undefined;
};

export const KanbanCard = ({
  entity,
  workspaceId,
  cardFields,
  properties,
  onRename,
}: KanbanCardProps) => {
  const name = getEntityName(entity);
  const file = getFirstFile(entity);
  const navigable = file !== null && isFileDisplayable(file);
  const isActivePeek = useInspectorStore((s) => {
    if (!s.activeId) {
      return false;
    }
    const tab = s.tabs.find((t) => t.id === s.activeId);
    return tab?.type === "pdf" && tab.entityId === entity.entityId;
  });
  const rename = useInlineRename({
    initial: name,
    onCommit: (value) => {
      onRename?.(entity.entityId, value);
    },
  });

  const dragRef = useRef<HTMLDivElement>(null);

  useExternalSyncEffect(() => {
    const el = dragRef.current;
    if (!el) {
      return undefined;
    }
    return draggable({
      element: el,
      getInitialData: () => ({
        type: ENTITY_DRAG_TYPE,
        entityId: entity.entityId,
        entityIds: [entity.entityId],
        entities: [
          {
            entityId: entity.entityId,
            name,
            kind: entity.kind,
            mimeType: file?.mimeType ?? null,
            parentId: entity.parentId ?? null,
          },
        ],
        name,
        kind: entity.kind,
        mimeType: file?.mimeType ?? null,
      }),
      onGenerateDragPreview: ({ nativeSetDragImage }) => {
        setCustomNativeDragPreview({
          nativeSetDragImage,
          getOffset: centerUnderPointer,
          render: ({ container }) => {
            // Clone the styled inner card (button or div)
            const inner = el.firstElementChild;
            if (!inner) {
              return;
            }
            const clone = inner.cloneNode(true);
            if (!(clone instanceof HTMLElement)) {
              return;
            }
            const rect = inner.getBoundingClientRect();
            clone.style.width = `${rect.width}px`;
            container.append(clone);
          },
        });
      },
    });
  }, [entity.entityId, name, entity.kind, file?.mimeType, entity.parentId]);

  const startEditing = () => {
    rename.startEditing(getKanbanCardRenameInitialValue(entity, name));
  };

  const icon = (
    <EntityKindIcon
      className="size-4 shrink-0"
      fileName={file?.fileName}
      kind={entity.kind}
      mimeType={file?.mimeType}
      status={entity.status}
    />
  );

  const nameElement =
    rename.state.mode === "edit" ? (
      <InlineEdit
        inputClassName="w-full font-medium"
        onCancel={rename.cancel}
        onChange={rename.setDraft}
        onCommit={() => {
          void rename.commit();
        }}
        value={rename.state.draft}
      />
    ) : (
      <span className="truncate">{name}</span>
    );

  const isTask = entity.kind === "task";
  const visibleCardFields = normalizeOptionalArray(cardFields);
  const valueFields = visibleCardFields.filter((fieldId) => {
    if (
      fieldId === getInternalPropertyId("created-by") ||
      fieldId === getInternalPropertyId("updated-at") ||
      fieldId === getInternalPropertyId("version") ||
      fieldId === getInternalPropertyId("status") ||
      fieldId === getInternalPropertyId("priority") ||
      fieldId === getInternalPropertyId("due-date") ||
      fieldId === getInternalPropertyId("kind")
    ) {
      return false;
    }
    // Verdict tiers render as unlabeled compliant/deviation tags that clutter
    // the card and can't be toggled off (verdict properties are excluded from
    // the visibility menu). The tier is already conveyed by the column when
    // grouping by a verdict, so keep verdict tiers off kanban cards.
    const property = properties?.find((p) => p.id === fieldId);
    return property?.tool.type !== "playbook-verdict";
  });
  const showAuthor = visibleCardFields.includes(
    getInternalPropertyId("created-by"),
  );
  const showUpdatedAt = visibleCardFields.includes(
    getInternalPropertyId("updated-at"),
  );
  const showVersion =
    !isTask && visibleCardFields.includes(getInternalPropertyId("version"));
  const metadataVisibility = getKanbanCardMetadataVisibility(
    visibleCardFields,
    isTask,
  );
  const showMetadataBadges =
    metadataVisibility.showStatus ||
    metadataVisibility.showPriority ||
    metadataVisibility.showDueDate;
  const showFooter = showAuthor || showUpdatedAt || showVersion;

  const content = (
    <div className="flex flex-col gap-2 pe-5">
      <span className="flex min-w-0 items-center gap-1.5 text-sm leading-snug font-medium">
        {icon}
        {nameElement}
        {entity.activeEditBy && (
          <ActiveEditBadge
            className="shrink-0"
            image={entity.activeEditBy.image}
            name={entity.activeEditBy.name}
          />
        )}
      </span>
      {isTask && <TaskBadges entity={entity} />}
      {showMetadataBadges && (
        <KanbanEntityMetadataBadges
          entity={entity}
          showDueDate={metadataVisibility.showDueDate}
          showPriority={metadataVisibility.showPriority}
          showStatus={metadataVisibility.showStatus}
        />
      )}
      {properties && valueFields.length > 0 && (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {valueFields.map((fieldId) => {
            const propertyId = toSafeId<"property">(fieldId);
            const field = entity.fields[propertyId];
            const property = properties.find((p) => p.id === propertyId);
            if (!property || !field || field.content.type === "file") {
              return null;
            }
            return (
              <KanbanCardFieldValue
                content={field.content}
                entity={entity}
                fieldId={field.id}
                key={fieldId}
                property={property}
                workspaceId={workspaceId}
              />
            );
          })}
        </div>
      )}
      {showFooter && (
        <KanbanCardFooter
          entity={entity}
          showAuthor={showAuthor}
          showUpdatedAt={showUpdatedAt}
          showVersion={showVersion}
        />
      )}
    </div>
  );

  const actionsButton = onRename ? (
    <div className="absolute end-1.5 top-1.5 opacity-0 transition-opacity group-hover/card:opacity-100">
      <RowActions
        entity={entity}
        onRename={startEditing}
        triggerClassName=""
        workspaceId={workspaceId}
      />
    </div>
  ) : null;

  const isActiveTask = useInspectorStore((s) => {
    if (!s.activeId) {
      return false;
    }
    const tab = s.tabs.find((t) => t.id === s.activeId);
    return tab?.type === "task" && tab.id === entity.entityId;
  });

  // SAFETY: the ref is attached to either a <div> (task) or <button>
  // (navigable file); both extend HTMLElement which useInspectorFlash needs.
  const cardRef = useRef<HTMLDivElement>(null);
  useInspectorFlash(entity.entityId, cardRef);

  if (isTask) {
    return (
      <div className="group/card" ref={dragRef}>
        <div
          className={cn(
            "bg-card relative block w-full cursor-pointer rounded-lg border p-3 text-start shadow-xs transition-shadow hover:shadow-md",
            isActiveTask && "ring-primary/30 ring-2",
          )}
          // eslint-disable-next-line react/react-compiler -- containedHandler house pattern; cardRef is handed to the helper, not read for rendered output
          onClick={containedHandler(cardRef, () =>
            useInspectorStore.getState().openTask({
              taskId: entity.entityId,
              workspaceId,
              label: name,
            }),
          )}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              useInspectorStore.getState().openTask({
                taskId: entity.entityId,
                workspaceId,
                label: name,
              });
            }
          }}
          ref={cardRef}
          role="button"
          tabIndex={0}
        >
          {content}
          {actionsButton}
        </div>
      </div>
    );
  }

  if (navigable) {
    return (
      <div className="group/card" ref={dragRef}>
        <div
          className={cn(
            "bg-card relative block w-full cursor-pointer rounded-lg border p-3 text-start shadow-xs transition-shadow hover:shadow-md",
            isActivePeek && "ring-primary/30 ring-2",
          )}
          // eslint-disable-next-line react/react-compiler -- containedHandler house pattern; cardRef is handed to the helper, not read for rendered output
          onClick={containedHandler(cardRef, () =>
            useInspectorStore.getState().openFile({
              id: file.fieldId,
              entityId: file.entityId,
              label: name,
              fileName: file.fileName,
              mimeType: file.mimeType,
              pdfFileId: file.pdfFileId,
              propertyId: file.propertyId,
              workspaceId,
            }),
          )}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              useInspectorStore.getState().openFile({
                id: file.fieldId,
                entityId: file.entityId,
                label: name,
                fileName: file.fileName,
                mimeType: file.mimeType,
                pdfFileId: file.pdfFileId,
                propertyId: file.propertyId,
                workspaceId,
              });
            }
          }}
          ref={cardRef}
          role="button"
          tabIndex={0}
        >
          {content}
          {actionsButton}
        </div>
      </div>
    );
  }

  return (
    <div className="group/card" ref={dragRef}>
      <div
        className={cn(
          "bg-card relative rounded-lg border p-3 shadow-xs",
          isActivePeek && "ring-primary/30 ring-2",
        )}
      >
        {content}
        {actionsButton}
      </div>
    </div>
  );
};

type KanbanEntityMetadataBadgesProps = {
  entity: WorkspaceEntity;
  showStatus: boolean;
  showPriority: boolean;
  showDueDate: boolean;
};

const KanbanEntityMetadataBadges = ({
  entity,
  showStatus,
  showPriority,
  showDueDate,
}: KanbanEntityMetadataBadgesProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const status = showStatus ? entity.status : null;
  const priority = showPriority ? entity.priority : null;
  const dueDate = showDueDate ? entity.dueDate : null;

  if (!status && (!priority || priority === "none") && !dueDate) {
    return null;
  }

  const StatusIcon = isTaskStatus(status) ? STATUS_ICONS[status] : null;
  const PriorityIcon = isTaskPriority(priority)
    ? PRIORITY_ICONS[priority]
    : null;
  const statusLabel = (() => {
    switch (status) {
      case "open":
        return t("tasks.statusValues.open");
      case "in_progress":
        return t("tasks.statusValues.in_progress");
      case "in_review":
        return t("tasks.statusValues.in_review");
      case "done":
        return t("tasks.statusValues.done");
      case "cancelled":
        return t("tasks.statusValues.cancelled");
      case null:
        return null;
      default:
        return status;
    }
  })();
  const priorityLabel = (() => {
    switch (priority) {
      case "urgent":
        return t("tasks.priorityValues.urgent");
      case "high":
        return t("tasks.priorityValues.high");
      case "medium":
        return t("tasks.priorityValues.medium");
      case "low":
        return t("tasks.priorityValues.low");
      case "none":
        return t("tasks.priorityValues.none");
      case null:
        return null;
      default:
        return priority;
    }
  })();

  return (
    <div className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-1.5 text-xs leading-none">
      {status && (
        <span className="bg-muted/60 flex max-w-full min-w-0 items-center gap-1 rounded px-1.5 py-0.5">
          {StatusIcon && (
            <StatusIcon
              className={cn(
                "size-3 shrink-0",
                isTaskStatus(status) && STATUS_COLORS[status],
              )}
            />
          )}
          <span className="truncate">{statusLabel}</span>
        </span>
      )}
      {priority && priority !== "none" && (
        <span className="bg-muted/60 flex max-w-full min-w-0 items-center gap-1 rounded px-1.5 py-0.5">
          {PriorityIcon && (
            <PriorityIcon
              className={cn(
                "size-3 shrink-0",
                isTaskPriority(priority) && PRIORITY_COLORS[priority],
              )}
            />
          )}
          <span className="truncate">{priorityLabel}</span>
        </span>
      )}
      {dueDate && (
        <span className="bg-muted/60 flex max-w-full min-w-0 items-center gap-1 rounded px-1.5 py-0.5">
          <CalendarIcon className="size-3 shrink-0" />
          <span className="truncate">
            {format.dateTime(new Date(dueDate), {
              day: "numeric",
              month: "short",
              year: "numeric",
              timeZone: "UTC",
            })}
          </span>
        </span>
      )}
    </div>
  );
};

type KanbanCardFieldValueProps = {
  content: WorkspaceFieldContent;
  entity: WorkspaceEntity;
  fieldId: string;
  property: WorkspaceProperty;
  workspaceId: string;
};

const KanbanCardFieldValue = ({
  content,
  entity,
  fieldId,
  property,
  workspaceId,
}: KanbanCardFieldValueProps) => {
  const { setLocked } = useCellMetadataFlags({
    workspaceId,
    entityId: entity.entityId,
    propertyId: property.id,
    metadata: entity.cellMetadata[property.id],
  });
  const manualSaveProps =
    property.tool.type === "ai-model"
      ? { onManualSave: () => setLocked(true) }
      : {};

  return (
    <EditableField
      content={content}
      displayVariant="kanban"
      entityId={entity.entityId}
      entityKind={entity.kind}
      fieldId={fieldId}
      property={property}
      propertyId={property.id}
      readonly={entity.readOnly}
      workspaceId={workspaceId}
      {...manualSaveProps}
    />
  );
};

type KanbanCardFooterProps = {
  entity: WorkspaceEntity;
  showAuthor: boolean;
  showUpdatedAt: boolean;
  showVersion: boolean;
};

const KanbanCardFooter = ({
  entity,
  showAuthor,
  showUpdatedAt,
  showVersion,
}: KanbanCardFooterProps) => {
  if (entity.kind === "folder") {
    return null;
  }

  const authorInitials =
    entity.createdBy === null
      ? ""
      : entity.createdBy
          .split(" ")
          .map((part) => part.at(0))
          .join("")
          .slice(0, 2)
          .toUpperCase();

  return (
    <div className="text-muted-foreground flex min-w-0 items-center gap-2 text-xs leading-none">
      {showAuthor && entity.createdBy && (
        <span className="flex min-w-0 items-center gap-1">
          <Avatar className="size-4 text-[9px]">
            {entity.createdByImage && (
              <AvatarImage alt={entity.createdBy} src={entity.createdByImage} />
            )}
            <AvatarFallback>{authorInitials}</AvatarFallback>
          </Avatar>
          <span className="truncate">{entity.createdBy}</span>
        </span>
      )}
      {showUpdatedAt && (
        <span className="shrink-0">
          {formatRelativeTime(entity.updatedAt ?? entity.createdAt)}
        </span>
      )}
      {showVersion && <span className="shrink-0">v{entity.version}</span>}
    </div>
  );
};
