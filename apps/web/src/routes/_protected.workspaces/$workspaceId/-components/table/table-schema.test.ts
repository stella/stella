import { describe, expect, test } from "bun:test";

import {
  duplicateColumnIds,
  hideableColumnIds,
  sortableColumnIds,
  tableColumnIds,
  tableColumnSizing,
  visibleColumnIds,
} from "@stll/ui/data-table";

import { getInternalPropertyId } from "@/components/workspaces/entity-utils";
import { toSafeId } from "@/lib/safe-id";
import type { WorkspaceProperty, WorkspaceView } from "@/lib/types";
import { workspaceTableSchema } from "@/routes/_protected.workspaces/$workspaceId/-components/table/table-schema";

const LABELS = {
  name: "Name",
  itemType: "Type",
  status: "Status",
  priority: "Priority",
  dueDate: "Due",
  author: "Author",
  lastUpdated: "Updated",
  version: "Version",
};

const property = (id: string): WorkspaceProperty => ({
  id: toSafeId<"property">(id),
  name: id,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  workspaceId: toSafeId<"workspace">("workspace-1"),
  status: "fresh",
  kinds: null,
  content: { version: 1, type: "text" },
  tool: { version: 1, type: "manual-input" },
});

const view = (
  filters: WorkspaceView<"table">["layout"]["filters"] = [],
): WorkspaceView<"table"> => ({
  version: 1,
  id: "view-1",
  name: "Table",
  position: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  layout: {
    version: 1,
    type: "table",
    filters,
    sorts: [],
    hiddenProperties: [],
    calculations: [],
    columnOrder: [],
    columnPinning: [],
  },
});

const schemaFor = (properties: WorkspaceProperty[] = []) =>
  workspaceTableSchema({ properties, view: view(), labels: LABELS });

describe("workspaceTableSchema", () => {
  test("a document table runs select, properties, metadata, add-property", () => {
    expect(tableColumnIds(schemaFor([property("phase")]))).toEqual([
      "select",
      "phase",
      getInternalPropertyId("created-by"),
      getInternalPropertyId("updated-at"),
      getInternalPropertyId("version"),
      "add-property",
    ]);
  });

  test("neither utility column can be sorted or hidden", () => {
    const schema = schemaFor();

    expect(sortableColumnIds(schema)).not.toContain("select");
    expect(sortableColumnIds(schema)).not.toContain("add-property");
    expect(hideableColumnIds(schema)).not.toContain("select");
    expect(hideableColumnIds(schema)).not.toContain("add-property");
  });

  test("the select column stays visible however the view is stored", () => {
    const schema = schemaFor([property("phase")]);

    expect(visibleColumnIds(schema, tableColumnIds(schema))).toEqual([
      "select",
      "add-property",
    ]);
  });

  test("a hidden property drops out of the columns", () => {
    const schema = schemaFor([property("phase"), property("owner")]);

    expect(visibleColumnIds(schema, ["phase"])).not.toContain("phase");
    expect(visibleColumnIds(schema, ["phase"])).toContain("owner");
  });

  test("two properties never collide on a column id", () => {
    expect(
      duplicateColumnIds(schemaFor([property("phase"), property("owner")])),
    ).toEqual([]);
  });

  test("every column starts at a width", () => {
    const schema = schemaFor([property("phase")]);
    const sizing = tableColumnSizing(schema);

    for (const id of tableColumnIds(schema)) {
      expect(sizing[id]).toBeGreaterThan(0);
    }
  });

  test("a property column carries the property it draws", () => {
    const schema = schemaFor([property("phase")]);
    const column = schema.columns.find((candidate) => candidate.id === "phase");

    expect(column?.render).toEqual({
      type: "property",
      property: property("phase"),
      verdictProperty: undefined,
    });
    expect(column?.label).toBe("phase");
  });
});
