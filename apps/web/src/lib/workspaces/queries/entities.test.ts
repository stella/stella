import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/lib/safe-id";
import type { WorkspaceProperty } from "@/lib/types";

import {
  entitiesKeys,
  keepsRowsAcrossFind,
  visibleEntityFieldIds,
} from "./entities.logic";
import type { KanbanGroupKey } from "./entities.logic";

const propertyContent = (
  type: WorkspaceProperty["content"]["type"],
): WorkspaceProperty["content"] => {
  if (type === "single-select" || type === "multi-select") {
    return { version: 1, type, options: [], fallback: null };
  }
  if (type === "money") {
    return { version: 1, type, currency: null };
  }
  return { version: 1, type };
};

const property = (
  id: string,
  type: WorkspaceProperty["content"]["type"],
): WorkspaceProperty => ({
  id: toSafeId<"property">(id),
  name: id,
  createdAt: new Date("2025-01-01T00:00:00.000Z"),
  workspaceId: toSafeId<"workspace">("workspace-1"),
  status: "fresh",
  kinds: null,
  content: propertyContent(type),
  tool: { version: 1, type: "manual-input" },
});

describe("entity query keys", () => {
  test("composes detail and version-history keys from the workspace root", () => {
    expect(entitiesKeys.detail("workspace-1", "entity-1")).toEqual([
      "entities",
      "workspace-1",
      "entity-1",
    ]);
    expect(entitiesKeys.versions("workspace-1", "entity-1")).toEqual([
      "entities",
      "workspace-1",
      "entity-1",
      "versions",
    ]);
  });
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
    const visibleKey = entitiesKeys.sample({
      workspaceId: "workspace-1",
      filters: [],
      sorts: [],
      fieldMode: "visible",
      fieldIds: ["status", "due", "status"],
    });
    const fullKey = entitiesKeys.sample({
      workspaceId: "workspace-1",
      filters: [],
      sorts: [],
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

  test("keeps search in the sample cache identity", () => {
    const searchKey = entitiesKeys.sample({
      workspaceId: "workspace-1",
      filters: [],
      sorts: [],
      search: " closing binder ",
    });
    const emptyKey = entitiesKeys.sample({
      workspaceId: "workspace-1",
      filters: [],
      sorts: [],
    });

    expect(searchKey).not.toEqual(emptyKey);
    expect(searchKey.at(-1)).toMatchObject({
      search: "closing binder",
    });
    expect(emptyKey.at(-1)).not.toHaveProperty("search");
  });

  test("keeps the AI-previewable flag in the sample cache identity", () => {
    const previewKey = entitiesKeys.sample({
      workspaceId: "workspace-1",
      filters: [],
      sorts: [],
      pageSize: 50,
      fieldMode: "visible",
      previewableForAi: true,
    });
    const regularKey = entitiesKeys.sample({
      workspaceId: "workspace-1",
      filters: [],
      sorts: [],
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

  test("keeps excluded kinds in the sample cache identity", () => {
    expect(
      entitiesKeys
        .sample({
          workspaceId: "workspace-1",
          filters: [],
          sorts: [],
          excludedKinds: ["task", "folder"],
        })
        .at(-1),
    ).toMatchObject({
      excludedKinds: ["folder", "task"],
    });
  });

  test("keeps extra caller fields out of the sample cache identity", () => {
    const cleanKey = entitiesKeys.sample({
      workspaceId: "workspace-1",
      filters: [],
      sorts: [],
      search: "nda",
    });
    const noisyInput = {
      workspaceId: "workspace-1",
      filters: [],
      sorts: [],
      search: "nda",
      cursor: "cursor-that-must-not-leak",
    };

    expect(entitiesKeys.sample(noisyInput)).toEqual(cleanKey);
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
        includeAssignees: false,
      },
    ]);
  });

  test("keeps includeAssignees in the window cache identity", () => {
    const withAssignees = entitiesKeys.window({
      workspaceId: "workspace-1",
      filters: [],
      sorts: [],
      includeAssignees: true,
    });
    const withoutAssignees = entitiesKeys.window({
      workspaceId: "workspace-1",
      filters: [],
      sorts: [],
    });

    expect(withAssignees).not.toEqual(withoutAssignees);
    expect(withAssignees.at(-1)).toMatchObject({ includeAssignees: true });
    expect(withoutAssignees.at(-1)).toMatchObject({
      includeAssignees: false,
    });
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

describe("keeping a group's rows across a key change", () => {
  const find = (term: string): KanbanGroupKey["find"] => ({
    scope: { propertyIds: ["memo", "tags"], type: "all" },
    term,
  });
  const base: KanbanGroupKey = {
    workspaceId: "workspace-1",
    filters: [],
    sorts: [],
    fieldMode: "visible",
    fieldIds: ["status"],
    groupByPropertyId: "_status",
    groupValue: "open",
    find: find("lease"),
  };
  const keyOf = (key: KanbanGroupKey) => entitiesKeys.kanbanGroup(key);

  test("keeps them while only the columns change", () => {
    expect(
      keepsRowsAcrossFind(keyOf(base), {
        ...base,
        fieldIds: ["status", "due"],
      }),
    ).toBe(true);
  });

  test("keeps them across a filter, a sort and a page size", () => {
    expect(
      keepsRowsAcrossFind(keyOf(base), {
        ...base,
        limit: 50,
        sorts: [{ propertyId: "due", desc: true }],
      }),
    ).toBe(true);
  });

  test("keeps them for the same find reached with a different spelling", () => {
    expect(
      keepsRowsAcrossFind(keyOf(base), {
        ...base,
        find: {
          scope: { propertyIds: ["tags", "memo"], type: "all" },
          term: "  lease ",
        },
      }),
    ).toBe(true);
  });

  test("drops them when the term changes", () => {
    expect(keepsRowsAcrossFind(keyOf(base), { ...base, find: find("lea") })) //
      .toBe(false);
  });

  test("drops them when the find narrows to other columns", () => {
    expect(
      keepsRowsAcrossFind(keyOf(base), {
        ...base,
        find: {
          scope: { propertyIds: ["memo"], type: "columns" },
          term: "lease",
        },
      }),
    ).toBe(false);
  });

  test("drops them when a find starts or ends", () => {
    const unfound = { ...base, find: undefined };
    expect(keepsRowsAcrossFind(keyOf(unfound), base)).toBe(false);
    expect(keepsRowsAcrossFind(keyOf(base), unfound)).toBe(false);
  });

  test("drops rows that belong to another workspace or group", () => {
    expect(
      keepsRowsAcrossFind(keyOf({ ...base, workspaceId: "workspace-2" }), base),
    ).toBe(false);
    expect(
      keepsRowsAcrossFind(keyOf({ ...base, groupValue: "done" }), base),
    ).toBe(false);
    expect(
      keepsRowsAcrossFind(keyOf({ ...base, groupByPropertyId: "_kind" }), base),
    ).toBe(false);
  });

  test("drops rows with no previous query, or one of another kind", () => {
    expect(keepsRowsAcrossFind(undefined, base)).toBe(false);
    expect(keepsRowsAcrossFind(entitiesKeys.window(base), base)).toBe(false);
  });
});
