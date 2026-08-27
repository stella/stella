import { describe, expect, test } from "bun:test";

import type { KanbanSchema } from "./grouping";
import { resolveKanbanGrouping } from "./grouping";
import { buildKanbanBoardMatrix, createKanbanDropIntent } from "./matrix";

type Row = { id: string; owner: string | null; status: string | null };
type Property = { id: string };

const schema: KanbanSchema<Row, Property> = {
  builtInGroups: [
    {
      id: "_status",
      options: [
        { label: "Open", value: "open" },
        { label: "Done", value: "done" },
      ],
    },
  ],
  getPropertyId: (property) => property.id,
  getPropertyOptions: (property) =>
    property.id === "owner"
      ? [
          { label: "Ada", value: "ada" },
          { label: "Lin", value: "lin" },
        ]
      : null,
  properties: [{ id: "owner" }],
};

const group = resolveKanbanGrouping({ groupBy: "_status", schema });
const subgroup = resolveKanbanGrouping({ groupBy: "owner", schema });

const valueFor = ({ grouping, row }: { grouping: typeof group; row: Row }) => {
  switch (grouping.type) {
    case "built-in":
      return grouping.propertyId === "_status" ? row.status : null;
    case "property":
      return row.owner;
    case "none":
      return null;
    default: {
      const exhaustive: never = grouping;
      return exhaustive;
    }
  }
};

describe("kanban board matrix", () => {
  test("places every primary-board row exactly once in stable incoming order", () => {
    const rows: Row[] = [
      { id: "one", owner: "ada", status: "open" },
      { id: "two", owner: null, status: "unexpected" },
      { id: "three", owner: "absent", status: "done" },
    ];
    const matrix = buildKanbanBoardMatrix({
      group,
      resolveGroupValue: valueFor,
      rows,
      subgroup,
      uncategorizedLabel: "No value",
    });

    expect(matrix.columns.map((column) => column.value)).toEqual([
      "open",
      "done",
      null,
    ]);
    expect(matrix.lanes).toHaveLength(3);
    expect(
      matrix.cells.flatMap((cell) => cell.rows).map((row) => row.id),
    ).toEqual(["one", "three", "two"]);
    expect(matrix.cells.at(0)?.rows.map((row) => row.id)).toEqual(["one"]);
  });

  test("a diagonal move carries both changed axes in one intent", () => {
    const matrix = buildKanbanBoardMatrix({
      group,
      resolveGroupValue: valueFor,
      rows: [{ id: "one", owner: "ada", status: "open" }],
      subgroup,
      uncategorizedLabel: "No value",
    });
    const source = matrix.cells.find(
      (cell) =>
        cell.coordinate.column.value === "open" &&
        cell.coordinate.lane.type === "group" &&
        cell.coordinate.lane.group.value === "ada",
    );
    const target = matrix.cells.find(
      (cell) =>
        cell.coordinate.column.value === "done" &&
        cell.coordinate.lane.type === "group" &&
        cell.coordinate.lane.group.value === "lin",
    );

    if (source === undefined || target === undefined) {
      throw new Error("fixture matrix must contain both cells");
    }
    expect(
      createKanbanDropIntent({
        cardId: "one",
        group,
        source: source.coordinate,
        subgroup,
        target: target.coordinate,
      }),
    ).toEqual({
      cardId: "one",
      changes: [
        { groupBy: "_status", value: "done" },
        { groupBy: "owner", value: "lin" },
      ],
      type: "move",
    });
  });
});
