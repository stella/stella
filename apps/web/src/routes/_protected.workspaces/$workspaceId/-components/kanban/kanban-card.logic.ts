import type { WorkspaceEntity, WorkspaceField } from "@/lib/types";
import { getInternalPropertyId } from "@/routes/_protected.workspaces/$workspaceId/-utils";

export type KanbanCardMetadataVisibility = {
  showStatus: boolean;
  showPriority: boolean;
  showDueDate: boolean;
};

export const getKanbanCardMetadataVisibility = (
  visibleCardFields: readonly string[],
  isTask: boolean,
): KanbanCardMetadataVisibility => ({
  showStatus:
    !isTask && visibleCardFields.includes(getInternalPropertyId("status")),
  showPriority:
    !isTask && visibleCardFields.includes(getInternalPropertyId("priority")),
  showDueDate:
    !isTask && visibleCardFields.includes(getInternalPropertyId("due-date")),
});

export const getKanbanCardRenameInitialValue = (
  entity: WorkspaceEntity,
  fallbackName: string,
) => {
  const textField = Object.values(entity.fields).find(
    (field): field is WorkspaceField => field?.content.type === "text",
  );
  const textName =
    textField?.content.type === "text" ? textField.content.value.trim() : "";

  return textName || fallbackName;
};
