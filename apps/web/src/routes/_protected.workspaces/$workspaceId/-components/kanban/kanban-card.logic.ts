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
