import { useRef, useState } from "react";
import { FolderIcon } from "lucide-react";
import { useDrag } from "react-aria";

import { cn } from "@stella/ui/lib/utils";

import {
  isFileDisplayable,
  type WorkspaceEntity,
  type WorkspaceProperty,
} from "@/lib/types";
import { CellResult } from "@/routes/_protected.workspaces/$workspaceId/-components/cell-result";
import { DocumentIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/document-icon";
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
} from "@/routes/_protected.workspaces/$workspaceId/-utils";

const ENTITY_DRAG_TYPE = "stella/entity-id";

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
  const { dragProps } = useDrag({
    getItems: () => [{ [ENTITY_DRAG_TYPE]: entity.entityId }],
  });

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
      <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
    ) : file?.mimeType ? (
      <DocumentIcon className="size-4 shrink-0" mimeType={file.mimeType} />
    ) : null;

  const nameElement = isEditing ? (
    <InlineEdit
      inputClassName="w-full font-medium"
      onChange={setEditValue}
      onCancel={() => {
        setIsEditing(false);
        setEditValue(name);
      }}
      onCommit={commitRename}
      value={editValue}
    />
  ) : (
    <span className="truncate">{name}</span>
  );

  const content = (
    <div className="flex flex-col gap-1 pr-5">
      <span className="flex items-center gap-1.5 text-sm leading-snug font-medium">
        {icon}
        {nameElement}
      </span>
      {cardFields &&
        cardFields.length > 0 &&
        properties &&
        cardFields.map((fieldId) => {
          if (fieldId === "__created_by__") {
            return (
              <div className="text-xs text-muted-foreground" key={fieldId}>
                <AuthorCell entity={entity} />
              </div>
            );
          }
          if (fieldId === "__updated_at__") {
            return (
              <div className="text-xs text-muted-foreground" key={fieldId}>
                <LastUpdatedCell entity={entity} />
              </div>
            );
          }
          if (fieldId === "__version__") {
            return (
              <div className="text-xs text-muted-foreground" key={fieldId}>
                <VersionCell entity={entity} />
              </div>
            );
          }
          const field = entity.fields[fieldId];
          const prop = properties.find((p) => p.id === fieldId);
          if (!prop || !field || field.content.type === "file") {
            return null;
          }
          return (
            <div className="text-xs text-muted-foreground" key={fieldId}>
              <CellResult field={field} property={prop} />
            </div>
          );
        })}
    </div>
  );

  const actionsButton = onRename ? (
    <div className="absolute top-1.5 right-1.5 opacity-0 transition-opacity group-hover/card:opacity-100">
      <RowActions
        entity={entity}
        onRename={startEditing}
        triggerClassName=""
        workspaceId={workspaceId}
      />
    </div>
  ) : null;

  if (navigable && file) {
    return (
      <div className="group/card relative" ref={dragRef} {...dragProps}>
        <button
          className={cn(
            "block w-full rounded-lg border bg-card p-3 text-left shadow-xs transition-shadow hover:shadow-md",
            isActivePeek && "ring-2 ring-primary/30",
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
        </button>
        {actionsButton}
      </div>
    );
  }

  return (
    <div className="group/card relative" ref={dragRef} {...dragProps}>
      <div
        className={cn(
          "rounded-lg border bg-card p-3 shadow-xs",
          isActivePeek && "ring-2 ring-primary/30",
        )}
      >
        {content}
      </div>
      {actionsButton}
    </div>
  );
};
