import {
  constructTable,
  createColumnHelper,
  createCoreRowModel,
} from "@tanstack/table-core";
import { storeReactivityBindings } from "@tanstack/table-core/store-reactivity-bindings";
import { describe, expect, test } from "bun:test";

import { workspaceTableFeatures } from "@/routes/_protected.workspaces/$workspaceId/-components/table/table-features";

const testFeatures = {
  coreReativityFeature: storeReactivityBindings(),
  ...workspaceTableFeatures,
};

type TestFeatures = typeof testFeatures;
type TestRow = {
  id: string;
  name: string;
};

const columnHelper = createColumnHelper<TestFeatures, TestRow>();

describe("workspace table v9 feature set", () => {
  test("keeps only the APIs the grid render path uses", () => {
    const table = constructTable({
      features: testFeatures,
      rowModels: { coreRowModel: createCoreRowModel() },
      data: [{ id: "row-a", name: "Alpha" }],
      columns: columnHelper.columns([
        columnHelper.accessor("name", { header: "Name" }),
      ]),
      getRowId: (row) => row.id,
    });

    expect(table.getRowModel().rows.map((row) => row.id)).toEqual(["row-a"]);
    expect(table.initialState.columnPinning).toEqual({ left: [], right: [] });
    expect(typeof table.options.rowModels?.coreRowModel).toBe("function");

    expect(typeof table.setColumnOrder).toBe("function");
    expect(typeof table.setColumnPinning).toBe("function");
    expect(typeof table.setColumnSizing).toBe("function");
    expect(typeof table.setColumnVisibility).toBe("function");
    expect(typeof table.setExpanded).toBe("function");
    expect(typeof table.setRowSelection).toBe("function");
    expect(typeof table.setSorting).toBe("function");

    expect("setColumnFilters" in table).toBe(false);
    expect("setGlobalFilter" in table).toBe(false);
    expect("setPagination" in table).toBe(false);
    expect("setGrouping" in table).toBe(false);
  });
});
