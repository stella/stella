import { describe, expect, test } from "bun:test";

import type { ConditionNode } from "@stll/conditions";

import { toSafeId } from "@/lib/safe-id";
import type { WorkspaceProperty } from "@/lib/types";
import {
  effectiveFindSelection,
  resolveFindScope,
  resolveTableFind,
  searchableColumnIds,
  toFindColumns,
  toggleFindColumn,
} from "@/routes/_protected.workspaces/$workspaceId/-components/table/table-find.logic";
import type { TableFindColumn } from "@/routes/_protected.workspaces/$workspaceId/-components/table/table-find.logic";
import type { TableFindSelection } from "@/routes/_protected.workspaces/$workspaceId/-hooks/table-store";

const property = (
  id: string,
  content: WorkspaceProperty["content"],
): WorkspaceProperty => ({
  content,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  id: toSafeId<"property">(id),
  kinds: null,
  name: id.toUpperCase(),
  status: "fresh",
  tool: { version: 1, type: "manual-input" },
  workspaceId: toSafeId<"workspace">("workspace-1"),
});

const TEXT = { version: 1, type: "text" } as const;

const properties = [
  property("text", TEXT),
  property("tags", {
    version: 1,
    type: "multi-select",
    options: [],
    fallback: null,
  }),
  property("signed", { version: 1, type: "date" }),
  property("fee", { version: 1, type: "money", currency: "USD" }),
  property("hidden", TEXT),
];

const hiddenProperties = ["hidden"];

const findColumns = (): TableFindColumn[] =>
  toFindColumns({ hiddenProperties, properties });

// A view admitting tasks renders a name column; one of documents alone does
// not.
const LIST_ITEMS_FILTER: ConditionNode = {
  type: "predicate",
  operand: { type: "kind" },
  op: "in",
  value: ["task"],
};

describe("the columns a find offers", () => {
  test("lists property columns in grid order", () => {
    expect(findColumns().map((column) => column.id)).toEqual([
      "text",
      "tags",
      "signed",
      "fee",
    ]);
  });

  test("leaves out hidden columns entirely", () => {
    // A row matching only in a column the reader cannot see would show no
    // highlight and read as a bug.
    expect(findColumns().map((column) => column.id)).not.toContain("hidden");
  });

  test("keeps types that cannot be searched, marked", () => {
    const bySupport = Object.fromEntries(
      findColumns().map((column) => [column.id, column.support]),
    );

    expect(bySupport).toEqual({
      fee: "excluded",
      signed: "excluded",
      tags: "searchable",
      text: "searchable",
    });
  });

  test("only the searchable ones can be reached", () => {
    expect(searchableColumnIds(findColumns())).toEqual(["text", "tags"]);
  });
});

describe("the selection the picker shows", () => {
  test("a column hidden while the find was live drops out", () => {
    // A stale id is inert server-side, so re-intersecting is what keeps the
    // picker and the search telling the same story.
    expect(
      effectiveFindSelection({
        columns: findColumns(),
        selection: {
          propertyIds: ["tags", "hidden", "signed"],
          type: "columns",
        },
      }),
    ).toEqual({ propertyIds: ["tags"], type: "columns" });
  });

  test("losing the last chosen column widens back to unrestricted", () => {
    // Otherwise the rows narrow to a search of no columns, the chip counts
    // zero columns, and the picker shows nothing a click could clear.
    expect(
      effectiveFindSelection({
        columns: findColumns(),
        selection: { propertyIds: ["hidden"], type: "columns" },
      }),
    ).toEqual({ type: "all" });
  });
});

describe("the scope a find is sent with", () => {
  test("unrestricted carries every searchable visible column", () => {
    expect(
      resolveFindScope({
        columns: findColumns(),
        hasNameColumn: true,
        selection: { type: "all" },
      }),
    ).toEqual({ propertyIds: ["text", "tags"], type: "all" });
  });

  test("unrestricted drops the name half where no name column renders", () => {
    // A documents-only view shows no name cell, so a row matched on its name
    // alone would arrive with nothing to mark.
    expect(
      resolveFindScope({
        columns: findColumns(),
        hasNameColumn: false,
        selection: { type: "all" },
      }),
    ).toEqual({ propertyIds: ["text", "tags"], type: "columns" });
  });

  test("a narrowed scope carries only what was chosen", () => {
    expect(
      resolveFindScope({
        columns: findColumns(),
        hasNameColumn: true,
        selection: { propertyIds: ["tags"], type: "columns" },
      }),
    ).toEqual({ propertyIds: ["tags"], type: "columns" });
  });

  test("a narrowed scope that lost every column is sent unrestricted", () => {
    expect(
      resolveFindScope({
        columns: findColumns(),
        hasNameColumn: true,
        selection: { propertyIds: ["hidden"], type: "columns" },
      }),
    ).toEqual({ propertyIds: ["text", "tags"], type: "all" });
  });
});

describe("resolving a view's find", () => {
  const layout = (filters: ConditionNode[]) => ({ filters, hiddenProperties });

  test("a blank term is no find at all", () => {
    expect(
      resolveTableFind({
        layout: layout([]),
        properties,
        selection: { type: "all" },
        term: "   ",
      }),
    ).toMatchObject({
      highlight: null,
      request: {},
      selection: { type: "all" },
    });
  });

  test("the request, the marks and the picker come from one pass", () => {
    const resolved = resolveTableFind({
      layout: layout([LIST_ITEMS_FILTER]),
      properties,
      selection: { propertyIds: ["tags", "hidden"], type: "columns" },
      term: " lease ",
    });

    expect(resolved.request).toEqual({
      find: {
        scope: { propertyIds: ["tags"], type: "columns" },
        term: "lease",
      },
    });
    expect(resolved.highlight).toEqual({
      matchesName: false,
      propertyIds: new Set(["tags"]),
      term: "lease",
    });
    expect(resolved.selection).toEqual({
      propertyIds: ["tags"],
      type: "columns",
    });
  });

  test("the name is marked only where a name column renders", () => {
    const withName = resolveTableFind({
      layout: layout([LIST_ITEMS_FILTER]),
      properties,
      selection: { type: "all" },
      term: "lease",
    });
    const withoutName = resolveTableFind({
      layout: layout([]),
      properties,
      selection: { type: "all" },
      term: "lease",
    });

    expect(withName.highlight?.matchesName).toBe(true);
    expect(withoutName.highlight?.matchesName).toBe(false);
    expect(withoutName.request.find?.scope.type).toBe("columns");
  });
});

describe("clicking a column in the picker", () => {
  const searchable = ["text", "tags"];
  const toggle = (columnId: string, selection: TableFindSelection) =>
    toggleFindColumn({ columnId, searchable, selection });

  test("the first click narrows to that column alone", () => {
    // Not "every column except this one": under `all` nothing is ticked, so
    // the click is what the reader means by it.
    expect(toggle("tags", { type: "all" })).toEqual({
      propertyIds: ["tags"],
      type: "columns",
    });
  });

  test("a further click adds, in column order", () => {
    expect(toggle("text", { propertyIds: ["tags"], type: "columns" })).toEqual({
      propertyIds: ["text", "tags"],
      type: "columns",
    });
  });

  test("ticking every column is still a narrowed scope", () => {
    // `all` also matches the row's name, so "every cell and nothing else" is a
    // scope of its own, and the only one a single-column view can narrow to.
    expect(toggle("tags", { propertyIds: ["text"], type: "columns" })).toEqual({
      propertyIds: ["text", "tags"],
      type: "columns",
    });
  });

  test("clearing the last tick returns to unrestricted", () => {
    // A search of no columns is one nothing can satisfy.
    expect(toggle("tags", { propertyIds: ["tags"], type: "columns" })).toEqual({
      type: "all",
    });
  });
});
