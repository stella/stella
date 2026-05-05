import { describe, expect, test } from "bun:test";

import {
  getGridTemplateColumns,
  getOrderedCells,
  getOrderedColumns,
  reorderColumnIds,
} from "@/routes/_protected.workspaces/$workspaceId/-components/table/workspace-grid-order";

const column = (id: string, size = 100) => ({
  id,
  getSize: () => size,
});

const cell = (id: string) => ({
  id: `${id}-cell`,
  column: { id },
});

describe("workspace grid column ordering", () => {
  test("places pinned columns before center columns", () => {
    const ordered = getOrderedColumns({
      leftColumns: [column("select", 48), column("documents", 240)],
      centerColumns: [column("status", 200), column("due-date", 160)],
      rightColumns: [],
    });

    expect(ordered.map((c) => c.id)).toEqual([
      "select",
      "documents",
      "status",
      "due-date",
    ]);
  });

  test("orders cells by the rendered column order instead of source order", () => {
    const orderedColumns = [
      column("select"),
      column("documents"),
      column("status"),
      column("due-date"),
    ];
    const sourceCells = [
      cell("select"),
      cell("status"),
      cell("documents"),
      cell("due-date"),
    ];

    expect(
      getOrderedCells(sourceCells, orderedColumns).map((c) => c.id),
    ).toEqual([
      "select-cell",
      "documents-cell",
      "status-cell",
      "due-date-cell",
    ]);
  });

  test("grid template has no hidden slot for a pinned column's original position", () => {
    const orderedColumns = getOrderedColumns({
      leftColumns: [column("select", 48), column("documents", 240)],
      centerColumns: [column("status", 200), column("due-date", 160)],
      rightColumns: [],
    });

    expect(getGridTemplateColumns(orderedColumns)).toBe(
      "48px 240px 200px 160px",
    );
  });

  test("keeps end utility columns as real columns", () => {
    expect(
      getGridTemplateColumns([
        column("select", 48),
        column("documents", 240),
        column("add-property", 40),
      ]),
    ).toBe("48px 240px 40px");
  });

  test("moves a dragged column before the targeted column", () => {
    expect(
      reorderColumnIds({
        ids: ["select", "documents", "status", "due-date"],
        sourceId: "due-date",
        targetId: "status",
        edge: "left",
      }),
    ).toEqual(["select", "documents", "due-date", "status"]);
  });

  test("moves a dragged column after the targeted column", () => {
    expect(
      reorderColumnIds({
        ids: ["select", "documents", "status", "due-date"],
        sourceId: "documents",
        targetId: "due-date",
        edge: "right",
      }),
    ).toEqual(["select", "status", "due-date", "documents"]);
  });
});
