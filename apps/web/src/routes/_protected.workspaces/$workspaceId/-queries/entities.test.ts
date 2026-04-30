import { describe, expect, test } from "bun:test";

import type { WorkspaceProperty } from "@/lib/types";

import { entitiesKeys, visibleEntityFieldIds } from "./entities.logic";

const property = (
  id: string,
  type: WorkspaceProperty["content"]["type"],
): WorkspaceProperty => ({
  id,
  name: id,
  createdAt: new Date("2025-01-01T00:00:00.000Z"),
  workspaceId: "workspace-1",
  status: "fresh",
  content:
    type === "single-select" || type === "multi-select"
      ? { version: 1, type, options: [], fallback: null }
      : { version: 1, type },
  tool: { version: 1, type: "manual-input" },
});

describe("entity query field selection", () => {
  test("keeps file metadata even when file columns are hidden", () => {
    expect(
      visibleEntityFieldIds({
        hiddenProperties: ["file", "notes"],
        properties: [
          property("file", "file"),
          property("status", "single-select"),
          property("notes", "text"),
          property("due", "date"),
        ],
      }),
    ).toEqual(["due", "file", "status"]);
  });

  test("keeps required fields even when the view hides them", () => {
    expect(
      visibleEntityFieldIds({
        hiddenProperties: ["group"],
        properties: [
          property("file", "file"),
          property("group", "single-select"),
          property("notes", "text"),
        ],
        requiredPropertyIds: ["group", "missing"],
      }),
    ).toEqual(["file", "group", "notes"]);
  });

  test("keeps field selection in the cache identity only for visible mode", () => {
    const visibleKey = entitiesKeys.page({
      workspaceId: "workspace-1",
      filters: [],
      sorts: [],
      page: 1,
      fieldMode: "visible",
      fieldIds: ["status", "due", "status"],
    });
    const fullKey = entitiesKeys.page({
      workspaceId: "workspace-1",
      filters: [],
      sorts: [],
      page: 1,
      fieldMode: "full",
      fieldIds: ["status"],
    });

    expect(visibleKey.at(-1)).toMatchObject({
      fieldMode: "visible",
      fieldIds: ["due", "status"],
    });
    expect(fullKey.at(-1)).toMatchObject({
      fieldMode: "full",
      fieldIds: [],
    });
  });

  test("keeps cursor state out of the window cache identity", () => {
    expect(
      entitiesKeys.window({
        workspaceId: "workspace-1",
        filters: [],
        sorts: [],
        limit: 200,
        fieldMode: "visible",
        fieldIds: ["status", "due", "status"],
        excludedKinds: ["task", "folder"],
      }),
    ).toEqual([
      "entities",
      "workspace-1",
      "window",
      {
        filters: [],
        sorts: [],
        limit: 200,
        fieldMode: "visible",
        fieldIds: ["due", "status"],
        excludedKinds: ["folder", "task"],
      },
    ]);
  });
});
