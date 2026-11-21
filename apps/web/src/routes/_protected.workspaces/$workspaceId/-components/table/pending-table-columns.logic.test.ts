import { describe, expect, test } from "bun:test";

import { getInternalColId } from "@/components/workspaces/internal-ids.logic";
import {
  ADD_PROPERTY_COLUMN_SIZE,
  PROPERTY_COLUMN_SIZE,
} from "@/components/workspaces/table/table-schema";
import { toSafeId } from "@/lib/safe-id";
import type { WorkspaceProperty, WorkspaceView } from "@/lib/types";
import { workspaceTableSchema } from "@/routes/_protected.workspaces/$workspaceId/-components/table/entity-table-schema";
import {
  isGroupedTableView,
  pendingTableGrid,
} from "@/routes/_protected.workspaces/$workspaceId/-components/table/pending-table-columns.logic";

const property = (id: string): WorkspaceProperty => ({
  id: toSafeId<"property">(id),
  name: id,
  createdAt: "2026-01-01T00:00:00.000Z",
  workspaceId: toSafeId<"workspace">("workspace-1"),
  status: "fresh",
  kinds: null,
  content: { version: 1, type: "text" },
  tool: { version: 1, type: "manual-input" },
});

type TableLayout = WorkspaceView<"table">["layout"];

const view = (layout: Partial<TableLayout> = {}): WorkspaceView<"table"> => ({
  version: 1,
  id: "view-1",
  name: "Table",
  position: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  layout: {
    version: 1,
    type: "table",
    filters: [],
    sorts: [],
    hiddenProperties: [],
    calculations: [],
    columnOrder: [],
    columnPinning: [],
    ...layout,
  },
});

const properties = [property("a"), property("b"), property("c")];
const select = getInternalColId("select");
const addProperty = getInternalColId("add-property");
const ids = (grid: ReturnType<typeof pendingTableGrid>) =>
  grid.renderColumns.map((column) => column.id);

describe("a loading table's columns", () => {
  test("are the schema's columns, in its order, at its widths", () => {
    const grid = pendingTableGrid({ properties, view: view() });
    const schema = workspaceTableSchema({
      properties,
      view: view(),
      labels: {
        name: "",
        itemType: "",
        status: "",
        priority: "",
        dueDate: "",
        author: "",
        lastUpdated: "",
        version: "",
        documents: "",
      },
    });
    const schemaIds = schema.columns
      .map((column) => column.id)
      .filter((id) => id !== addProperty);
    expect(ids(grid)).toEqual(schemaIds);
    expect(grid.addPropertyColumn?.id).toBe(addProperty);
    expect(
      grid.renderColumns.find((column) => column.id === "b")?.getSize(),
    ).toBe(PROPERTY_COLUMN_SIZE);
    expect(grid.tableWidth).toBe(
      schema.columns.reduce((sum, column) => sum + column.size, 0),
    );
  });

  test("leave out what the view hides, but never the selection column", () => {
    const grid = pendingTableGrid({
      properties,
      view: view({
        hiddenProperties: [
          toSafeId<"property">("b"),
          toSafeId<"property">(select),
        ],
      }),
    });
    expect(ids(grid)).toContain(select);
    expect(ids(grid)).not.toContain("b");
  });

  test("follow the saved order, and keep the unnamed ones after it", () => {
    const grid = pendingTableGrid({
      properties,
      view: view({
        columnOrder: [toSafeId<"property">("c"), toSafeId<"property">("a")],
      }),
    });
    expect(ids(grid).slice(0, 4)).toEqual([select, "c", "a", "b"]);
  });

  test("dock the selection and the pinned columns at the start, offset by the ones before", () => {
    const grid = pendingTableGrid({
      properties,
      view: view({ columnPinning: [toSafeId<"property">("c")] }),
    });
    const [first, second, third] = grid.renderColumns;
    expect(first?.id).toBe(select);
    expect(second?.id).toBe("c");
    expect(first?.getIsPinned()).toBe("start");
    expect(second?.getIsPinned()).toBe("start");
    expect(second?.getStart("start")).toBe(first?.getSize());
    expect(first?.getIsLastColumn("start")).toBe(false);
    expect(second?.getIsLastColumn("start")).toBe(true);
    expect(third?.getIsPinned()).toBe(false);
  });

  test("lay the grid out as the loaded table does: widths, the filler, the add-property column", () => {
    const grid = pendingTableGrid({ properties, view: view() });
    const widths = grid.renderColumns
      .map((column) => `${String(column.getSize())}px`)
      .join(" ");
    expect(grid.templateColumns).toBe(
      `${widths} minmax(0, 1fr) ${String(ADD_PROPERTY_COLUMN_SIZE)}px`,
    );
  });
});

describe("a loading table's widths", () => {
  test("take the widths a reader dragged, never below a column's minimum, and never for a utility column", () => {
    const base = pendingTableGrid({ properties, view: view() });
    const grid = pendingTableGrid({
      properties,
      sizing: { a: 333, b: 1, [select]: 999 },
      view: view(),
    });
    const width = (g: ReturnType<typeof pendingTableGrid>, id: string) =>
      g.renderColumns.find((column) => column.id === id)?.getSize();
    expect(width(grid, "a")).toBe(333);
    expect(width(grid, "b")).toBeGreaterThan(1);
    expect(width(grid, select)).toBe(width(base, select));
    expect(grid.tableWidth).toBe(
      base.tableWidth +
        333 -
        PROPERTY_COLUMN_SIZE +
        (width(grid, "b") ?? 0) -
        PROPERTY_COLUMN_SIZE,
    );
  });
});

describe("a grouped table view", () => {
  test("is grouped by a property unless it lists items", () => {
    expect(isGroupedTableView(view())).toBe(false);
    expect(
      isGroupedTableView(
        view({ groupByPropertyId: toSafeId<"property">("a") }),
      ),
    ).toBe(true);
  });
});
