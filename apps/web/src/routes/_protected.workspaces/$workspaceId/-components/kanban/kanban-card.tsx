import { useEffect, useRef, useState } from "react";

import { draggable } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { centerUnderPointer } from "@atlaskit/pragmatic-drag-and-drop/element/center-under-pointer";
import { setCustomNativeDragPreview } from "@atlaskit/pragmatic-drag-and-drop/element/set-custom-native-drag-preview";
import { FolderIcon } from "lucide-react";

import { cn } from "@stella/ui/lib/utils";

import { isFileDisplayable } from "@/lib/types";
import type { WorkspaceEntity, WorkspaceProperty } from "@/lib/types";
import { CellResult } from "@/routes/_protected.workspaces/$workspaceId/-components/cell-result";
import { DocumentIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/document-icon";
import { ENTITY_DRAG_TYPE } from "@/routes/_protected.workspaces/$workspaceId/-components/drag-constants";
import { InlineEdit } from "@/routes/_protected.workspaces/$workspaceId/-components/inline-edit";
import {
  AuthorCell,
  LastUpdatedCell,
  VersionCell,
} from "@/routes/_protected.workspaces/$workspaceId/-components/metadata-cells";
import { usePeekStore } from "@/routes/_protected.workspaces/$workspaceId/-components/peek/peek-store";
import { RowActions } from "@/routes/_protected.workspaces/$workspaceId/-components/row-actions";
import {
  getEntityName,
  getFirstFile,
  getInternalPropertyId,
} from "@/routes/_protected.workspaces/$workspaceId/-utils";

type KanbanCardProps = {
  entity: WorkspaceEntity;
  workspaceId: string;
  cardFields?: string[];
  properties?: WorkspaceProperty[];
  onRename?: (entityId: string, newName: string) => void;
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
  const isActivePeek = usePeekStore((s) => {
    if (!s.activeFieldId) {
      return false;
    }
    const tab = s.tabs.find((t) => t.fieldId === s.activeFieldId);
    return tab?.entityId === entity.entityId;
  });
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(name);

  // For editing, use the text field value (not the file name)
  const textField = Object.values(entity.fields).find(
    (f) => f.content.type === "text",
  );
  const textName =
    textField?.content.type === "text" ? textField.content.value.trim() : "";

  const dragRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = dragRef.current;
    if (!el) {
      return;
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
            // SAFETY: cloneNode of HTMLElement returns HTMLElement
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion
            const clone = inner.cloneNode(true) as HTMLElement;
            const rect = inner.getBoundingClientRect();
            clone.style.width = `${rect.width}px`;
            container.append(clone);
          },
        });
      },
    });
  }, [entity.entityId, name, entity.kind, file?.mimeType, entity.parentId]);

  const startEditing = () => {
    setEditValue(textName || name);
    setIsEditing(true);
  };

  const commitRename = () => {
    setIsEditing(false);
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== name) {
      onRename?.(entity.entityId, trimmed);
    }
  };

  const icon =
    entity.kind === "folder" ? (
      <FolderIcon className="text-muted-foreground size-4 shrink-0" />
    ) : file?.mimeType ? (
      <DocumentIcon className="size-4 shrink-0" mimeType={file.mimeType} />
    ) : null;

  const nameElement = isEditing ? (
    <InlineEdit
      inputClassName="w-full font-medium"
      onCancel={() => {
        setIsEditing(false);
        setEditValue(name);
      }}
      onChange={setEditValue}
      onCommit={commitRename}
      value={editValue}
    />
  ) : (
    <span className="truncate">{name}</span>
  );

  const content = (
    <div className="flex flex-col gap-1 pe-5">
      <span className="flex items-center gap-1.5 text-sm leading-snug font-medium">
        {icon}
        {nameElement}
      </span>
      {cardFields &&
        cardFields.length > 0 &&
        properties &&
        cardFields.map((fieldId) => {
          if (fieldId === getInternalPropertyId("created-by")) {
            return (
              <div className="text-muted-foreground text-xs" key={fieldId}>
                <AuthorCell entity={entity} />
              </div>
            );
          }
          if (fieldId === getInternalPropertyId("updated-at")) {
            return (
              <div className="text-muted-foreground text-xs" key={fieldId}>
                <LastUpdatedCell entity={entity} />
              </div>
            );
          }
          if (fieldId === getInternalPropertyId("version")) {
            return (
              <div className="text-muted-foreground text-xs" key={fieldId}>
                <VersionCell entity={entity} />
              </div>
            );
          }
          const field = entity.fields[fieldId];
          const prop = properties.find((p) => p.id === fieldId);
          if (
            prop === undefined ||
            prop === null ||
            field === undefined ||
            field === null ||
            field.content.type === "file"
          ) {
            return null;
          }
          return (
            <div className="text-muted-foreground text-xs" key={fieldId}>
              <CellResult field={field} property={prop} />
            </div>
          );
        })}
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

  if (navigable && file !== undefined) {
    return (
      <div className="group/card" ref={dragRef}>
        <button
          className={cn(
            "bg-card relative block w-full rounded-lg border p-3 text-start shadow-xs transition-shadow hover:shadow-md",
            isActivePeek && "ring-primary/30 ring-2",
          )}
          onClick={() =>
            usePeekStore.getState().openTab({
              fieldId: file.fieldId,
              entityId: file.entityId,
              label: name,
            })
          }
          type="button"
        >
          {content}
          {actionsButton}
        </button>
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
