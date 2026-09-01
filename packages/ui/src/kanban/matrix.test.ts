import { describe, expect, test } from "bun:test";

import type { KanbanGrouping, KanbanSchema } from "./grouping";
import { resolveKanbanGrouping } from "./grouping";
import {
  buildKanbanBoardMatrix,
  createKanbanDropIntent,
  orderKanbanCellsByColumns,
} from "./matrix";
import type { ResolveKanbanGroupValueParams } from "./matrix";

type Row = { id: string; owner: string | null; status: string | null };
type Property = { id: "owner" };
type GroupId = "_empty" | "_status" | "owner";

const schema: KanbanSchema<Row, Property, GroupId> = {
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
  getPropertyOptions: () => [
    { label: "Ada", value: "ada" },
    { label: "Lin", value: "lin" },
  ],
  properties: [{ id: "owner" }],
};

const group = resolveKanbanGrouping({ groupBy: "_status", schema });
const subgroup = resolveKanbanGrouping({ groupBy: "owner", schema });
const nonRenderableBuiltIn = {
  type: "built-in" as const,
  propertyId: "_empty",
  group: { id: "_empty", options: [] },
} as const satisfies KanbanGrouping<Row, Property, GroupId>;

const valueFor = ({
  grouping,
  row,
}: ResolveKanbanGroupValueParams<Row, Property, GroupId>) => {
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
  test("returns an empty matrix for a non-renderable primary built-in", () => {
    const matrix = buildKanbanBoardMatrix({
      group: nonRenderableBuiltIn,
      resolveGroupValue: valueFor,
      rows: [{ id: "one", owner: "ada", status: "open" }],
      subgroup,
      uncategorizedLabel: "No value",
    });

    expect(matrix).toEqual({ cells: [], columns: [], lanes: [], rows: [] });
  });

  test("normalizes a non-renderable subgroup to one lane without losing placement", () => {
    const matrix = buildKanbanBoardMatrix({
      group,
      resolveGroupValue: valueFor,
      rows: [
        { id: "one", owner: "ada", status: "open" },
        { id: "two", owner: "lin", status: "done" },
      ],
      subgroup: nonRenderableBuiltIn,
      uncategorizedLabel: "No value",
    });

    expect(matrix.lanes).toEqual([{ type: "none" }]);
    expect(
      matrix.cells
        .filter((cell) => cell.rows.length > 0)
        .map((cell) => [
          cell.coordinate.column.value,
          cell.rows.map((row) => row.id),
        ]),
    ).toEqual([
      ["open", ["one"]],
      ["done", ["two"]],
    ]);
  });

  test("orders a lane's cells by the visible column order", () => {
    const matrix = buildKanbanBoardMatrix({
      group,
      resolveGroupValue: valueFor,
      rows: [
        { id: "one", owner: "ada", status: "open" },
        { id: "two", owner: "ada", status: "done" },
      ],
      subgroup,
      uncategorizedLabel: "No value",
    });
    const adaCells = matrix.cells.filter(
      (cell) =>
        cell.coordinate.lane.type === "group" &&
        cell.coordinate.lane.group.value === "ada",
    );

    expect(
      orderKanbanCellsByColumns({
        cells: adaCells,
        columns: matrix.columns.toReversed(),
      }).map((cell) => cell.coordinate.column.value),
    ).toEqual([null, "done", "open"]);
  });

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
    const intent = createKanbanDropIntent({
      cardId: "one",
      group,
      source: source.coordinate,
      subgroup,
      target: target.coordinate,
    });
    const firstChange = intent?.changes.at(0);
    const axis: GroupId | undefined = firstChange?.groupBy;

    expect(axis).toBe("_status");
    expect(intent).toEqual({
      cardId: "one",
      changes: [
        { groupBy: "_status", value: "done" },
        { groupBy: "owner", value: "lin" },
      ],
      destination: null,
      type: "move",
    });
  });

  test("keeps terminal destinations as real matrix columns and drop targets", () => {
    const matrix = buildKanbanBoardMatrix({
      destinations: [{ id: "archive", label: "Archive" }],
      group,
      resolveGroupValue: valueFor,
      rows: [{ id: "one", owner: "ada", status: "open" }],
      subgroup,
      uncategorizedLabel: "No value",
    });
    const destination = matrix.columns.at(-1);
    if (destination === undefined) {
      throw new Error("Expected a terminal destination column");
    }
    expect(destination.label).toBe("Archive");
    expect(
      matrix.cells.filter(
        (cell) => cell.coordinate.column.value === destination.value,
      ),
    ).toHaveLength(3);
    const sourceCell = matrix.cells.at(0);
    const sourceLane = matrix.lanes.at(0);
    if (sourceCell === undefined || sourceLane === undefined) {
      throw new Error("Expected a source matrix cell and lane");
    }
    const intent = createKanbanDropIntent({
      cardId: "one",
      group,
      source: sourceCell.coordinate,
      subgroup,
      target: {
        column: destination,
        lane: sourceLane,
      },
    });
    expect(intent?.destination).toEqual({ id: "archive", label: "Archive" });
    expect(intent?.changes).toEqual([]);
  });
});
