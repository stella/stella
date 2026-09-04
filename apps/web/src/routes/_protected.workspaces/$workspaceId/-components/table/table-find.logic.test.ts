import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/lib/safe-id";
import type { WorkspaceProperty } from "@/lib/types";
import {
  resolveFindScope,
  searchableColumnIds,
  toFindColumns,
} from "@/routes/_protected.workspaces/$workspaceId/-components/table/table-find.logic";
import type { TableFindColumn } from "@/routes/_protected.workspaces/$workspaceId/-components/table/table-find.logic";
import type { WorkspaceColumnDescriptor } from "@/routes/_protected.workspaces/$workspaceId/-components/table/table-schema";

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

const propertyColumn = (
  id: string,
  content: WorkspaceProperty["content"],
): WorkspaceColumnDescriptor => ({
  capabilities: { hide: true, pin: true, resize: true, sort: true },
  emphasis: "content",
  id,
  label: id.toUpperCase(),
  render: {
    property: property(id, content),
    type: "property",
    verdictProperty: undefined,
  },
  size: 200,
});

const nameColumn: WorkspaceColumnDescriptor = {
  capabilities: { hide: true, pin: true, resize: true, sort: true },
  emphasis: "content",
  id: "_name",
  label: "Name",
  render: { type: "name" },
  size: 260,
};

const TEXT = { version: 1, type: "text" } as const;

const columns = [
  nameColumn,
  propertyColumn("text", TEXT),
  propertyColumn("tags", {
    version: 1,
    type: "multi-select",
    options: [],
    fallback: null,
  }),
  propertyColumn("signed", { version: 1, type: "date" }),
  propertyColumn("fee", { version: 1, type: "money", currency: "USD" }),
  propertyColumn("hidden", TEXT),
];

const findColumns = (): TableFindColumn[] =>
  toFindColumns({ columns, hiddenProperties: ["hidden"] });

describe("the columns a find offers", () => {
  test("leaves out everything that is not a property column", () => {
    expect(findColumns().map((column) => column.id)).not.toContain("_name");
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

describe("the scope a find is sent with", () => {
  test("unrestricted carries every searchable visible column", () => {
    expect(
      resolveFindScope({
        columns: findColumns(),
        selection: { type: "all" },
      }),
    ).toEqual({ propertyIds: ["text", "tags"], type: "all" });
  });

  test("a narrowed scope carries only what was chosen", () => {
    expect(
      resolveFindScope({
        columns: findColumns(),
        selection: { propertyIds: ["tags"], type: "columns" },
      }),
    ).toEqual({ propertyIds: ["tags"], type: "columns" });
  });

  test("a column hidden while the bar was open drops out of the scope", () => {
    // A stale id is inert server-side, so re-intersecting is what keeps the
    // picker and the search telling the same story.
    expect(
      resolveFindScope({
        columns: findColumns(),
        selection: {
          propertyIds: ["tags", "hidden", "signed"],
          type: "columns",
        },
      }),
    ).toEqual({ propertyIds: ["tags"], type: "columns" });
  });
});
