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

  test("keeps search in the page cache identity", () => {
    const searchKey = entitiesKeys.page({
      workspaceId: "workspace-1",
      filters: [],
      sorts: [],
      page: 1,
      search: " closing binder ",
    });
    const emptyKey = entitiesKeys.page({
      workspaceId: "workspace-1",
      filters: [],
      sorts: [],
      page: 1,
    });

    expect(searchKey).not.toEqual(emptyKey);
    expect(searchKey.at(-1)).toMatchObject({
      search: "closing binder",
    });
    expect(emptyKey.at(-1)).not.toHaveProperty("search");
  });

  test("keeps the AI-previewable flag in the page cache identity", () => {
    const previewKey = entitiesKeys.page({
      workspaceId: "workspace-1",
      filters: [],
      sorts: [],
      page: 1,
      pageSize: 50,
      fieldMode: "visible",
      previewableForAi: true,
    });
    const regularKey = entitiesKeys.page({
      workspaceId: "workspace-1",
      filters: [],
      sorts: [],
      page: 1,
      pageSize: 50,
      fieldMode: "visible",
    });

    expect(previewKey).not.toEqual(regularKey);
    expect(previewKey.at(-1)).toMatchObject({
      previewableForAi: true,
    });
    expect(regularKey.at(-1)).toMatchObject({
      previewableForAi: false,
    });
  });

  test("keeps excluded kinds in the page cache identity", () => {
    expect(
      entitiesKeys
        .page({
          workspaceId: "workspace-1",
          filters: [],
          sorts: [],
          page: 1,
          excludedKinds: ["task", "folder"],
        })
        .at(-1),
    ).toMatchObject({
      excludedKinds: ["folder", "task"],
    });
  });

  test("keeps extra caller fields out of the page cache identity", () => {
    const cleanKey = entitiesKeys.page({
      workspaceId: "workspace-1",
      filters: [],
      sorts: [],
      page: 1,
      search: "nda",
    });
    const noisyInput = {
      workspaceId: "workspace-1",
      filters: [],
      sorts: [],
      page: 1,
      search: "nda",
      cursor: "cursor-that-must-not-leak",
    };

    expect(entitiesKeys.page(noisyInput)).toEqual(cleanKey);
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
        previewableForAi: false,
      },
    ]);
  });

  test("keeps filesystem tree cache identity independent from page state", () => {
    expect(
      entitiesKeys
        .filesystemTree({
          workspaceId: "workspace-1",
          filters: [],
          sorts: [],
          search: " closing binder ",
          fieldMode: "visible",
          fieldIds: ["status", "due", "status"],
        })
        .at(-1),
    ).toEqual({
      filters: [],
      sorts: [],
      search: "closing binder",
      fieldMode: "visible",
      fieldIds: ["due", "status"],
    });
  });

  test("keeps search and AI-previewable state in the window cache identity", () => {
    const previewKey = entitiesKeys.window({
      workspaceId: "workspace-1",
      filters: [],
      sorts: [],
      search: " closing binder ",
      previewableForAi: true,
    });
    const regularKey = entitiesKeys.window({
      workspaceId: "workspace-1",
      filters: [],
      sorts: [],
      search: " closing binder ",
    });

    expect(previewKey).not.toEqual(regularKey);
    expect(previewKey.at(-1)).toMatchObject({
      search: "closing binder",
      previewableForAi: true,
    });
    expect(regularKey.at(-1)).toMatchObject({
      search: "closing binder",
      previewableForAi: false,
    });
  });

  test("keeps kanban group value in the cache identity", () => {
    const openKey = entitiesKeys.kanbanGroup({
      workspaceId: "workspace-1",
      filters: [],
      sorts: [],
      limit: 200,
      fieldMode: "visible",
      fieldIds: ["status", "due", "status"],
      groupByPropertyId: "_status",
      groupValue: "open",
    });
    const doneKey = entitiesKeys.kanbanGroup({
      workspaceId: "workspace-1",
      filters: [],
      sorts: [],
      limit: 200,
      fieldMode: "visible",
      fieldIds: ["status", "due", "status"],
      groupByPropertyId: "_status",
      groupValue: "done",
    });

    expect(openKey).not.toEqual(doneKey);
    expect(openKey.at(-1)).toMatchObject({
      fieldIds: ["due", "status"],
      groupByPropertyId: "_status",
      groupValue: "open",
    });
  });
});
