import { describe, expect, test } from "bun:test";

import { getInternalPropertyId } from "@/routes/_protected.workspaces/$workspaceId/-utils";

import { getKanbanCardMetadataVisibility } from "./kanban-card.logic";

describe("kanban card metadata visibility", () => {
  test("preserves task metadata chips for non-task cards", () => {
    const visibility = getKanbanCardMetadataVisibility(
      [
        getInternalPropertyId("status"),
        getInternalPropertyId("priority"),
        getInternalPropertyId("due-date"),
      ],
      false,
    );

    expect(visibility).toEqual({
      showStatus: true,
      showPriority: true,
      showDueDate: true,
    });
  });

  test("leaves task metadata to task-specific badges", () => {
    const visibility = getKanbanCardMetadataVisibility(
      [
        getInternalPropertyId("status"),
        getInternalPropertyId("priority"),
        getInternalPropertyId("due-date"),
      ],
      true,
    );

    expect(visibility).toEqual({
      showStatus: false,
      showPriority: false,
      showDueDate: false,
    });
  });
});
