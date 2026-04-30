import { describe, expect, test } from "bun:test";

import type { WorkspaceEntity, WorkspaceProperty } from "@/lib/types";
import { getInternalPropertyId } from "@/routes/_protected.workspaces/$workspaceId/-utils";

import {
  resolveKanbanGrouping,
  selectKanbanEntitiesForGrouping,
} from "./kanban-view.logic";

const entity = (
  entityId: string,
  kind: WorkspaceEntity["kind"],
): WorkspaceEntity => ({
  entityId,
  kind,
  name: entityId,
  parentId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  createdBy: null,
  createdByImage: null,
  updatedAt: null,
  version: 1,
  status: kind === "task" ? "open" : null,
  priority: null,
  dueDate: null,
  sortOrder: null,
  activeEditBy: null,
  fields: {},
});

const singleSelectProperty = (id: string): WorkspaceProperty => ({
  id,
  name: id,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  workspaceId: "workspace-1",
  status: "fresh",
  content: {
    version: 1,
    type: "single-select",
    options: [],
    fallback: null,
  },
  tool: { version: 1, type: "manual-input" },
});

describe("kanban grouping entity scope", () => {
  test("kind grouping keeps matter documents and folders", () => {
    const grouping = resolveKanbanGrouping(getInternalPropertyId("kind"), []);
    const result = selectKanbanEntitiesForGrouping(
      [
        entity("document-1", "document"),
        entity("folder-1", "folder"),
        entity("task-1", "task"),
      ],
      grouping,
    );

    expect(result.map((row) => row.kind)).toEqual([
      "document",
      "folder",
      "task",
    ]);
  });

  test("status grouping is task-only", () => {
    const grouping = resolveKanbanGrouping(getInternalPropertyId("status"), []);
    const result = selectKanbanEntitiesForGrouping(
      [entity("document-1", "document"), entity("task-1", "task")],
      grouping,
    );

    expect(result.map((row) => row.kind)).toEqual(["task"]);
  });

  test("custom property grouping keeps matter entities", () => {
    const grouping = resolveKanbanGrouping("phase", [
      singleSelectProperty("phase"),
    ]);
    const result = selectKanbanEntitiesForGrouping(
      [entity("document-1", "document"), entity("task-1", "task")],
      grouping,
    );

    expect(grouping.type).toBe("property");
    expect(result.map((row) => row.kind)).toEqual(["document", "task"]);
  });
});
