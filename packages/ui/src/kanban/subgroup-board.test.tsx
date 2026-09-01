import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import type { KanbanSchema } from "./grouping";
import { resolveKanbanGrouping } from "./grouping";
import { buildKanbanBoardMatrix } from "./matrix";
import { KanbanSubgroupBoard } from "./subgroup-board";

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
  getPropertyId: ({ id }) => id,
  getPropertyOptions: ({ id }) =>
    id === "owner"
      ? [
          { label: "Ada", value: "ada" },
          { label: "Lin", value: "lin" },
        ]
      : null,
  properties: [{ id: "owner" }],
};

const group = resolveKanbanGrouping({ groupBy: "_status", schema });
const subgroup = resolveKanbanGrouping({ groupBy: "owner", schema });
const noSubgroup = resolveKanbanGrouping({ groupBy: "", schema });
const testLabel = (...values: readonly unknown[]) => values.join(":");
const matrix = buildKanbanBoardMatrix({
  group,
  subgroup,
  rows: [{ id: "one", owner: "ada", status: "open" }],
  uncategorizedLabel: "No value",
  resolveGroupValue: ({ grouping, row }) =>
    grouping.type === "built-in" ? row.status : row.owner,
});

const renderBoard = (boardMatrix = matrix, expandEmptyLanes = false) =>
  renderToStaticMarkup(
    <KanbanSubgroupBoard
      {...(expandEmptyLanes
        ? {
            isLaneCollapsed: () => false,
            onLaneCollapsedChange: () => undefined,
          }
        : {})}
      matrix={boardMatrix}
      renderCell={({ cell, count, laneValue }) => (
        <span>
          {testLabel(
            "cell",
            laneValue,
            cell.coordinate.column.type === "group"
              ? cell.coordinate.column.group.value
              : cell.coordinate.column.destination.id,
            count,
          )}
        </span>
      )}
      renderColumnHeader={({ column, count }) => (
        <span>
          {testLabel(
            "column",
            column.type === "group"
              ? column.group.value
              : column.destination.id,
            count,
          )}
        </span>
      )}
      renderLaneIdentity={({ group: lane, count }) => (
        <span>{testLabel("lane", lane.value, count)}</span>
      )}
    />,
  );

describe("KanbanSubgroupBoard", () => {
  test("aligns every column and renders populated lanes expanded", () => {
    const markup = renderBoard();

    expect(markup).toContain("column:open:1");
    expect(markup).toContain("column:done:0");
    expect(markup).toContain("lane:ada:1");
    expect(markup).toContain("cell:ada:open:1");
    expect(markup).toContain('aria-expanded="true"');
  });

  test("collapses empty lanes by default and supports controlled expansion", () => {
    const collapsed = renderBoard();
    const expanded = renderBoard(matrix, true);

    expect(collapsed).toContain("lane:lin:0");
    expect(collapsed).toContain('data-kanban-lane-column-count="1"');
    expect(collapsed).toContain('data-kanban-lane-column-count="0"');
    expect(collapsed).not.toContain("cell:lin:open:0");
    expect(collapsed).toContain('aria-expanded="false"');
    expect(expanded).toContain("cell:lin:open:0");
    expect(expanded).toContain("cell:lin:done:0");
    expect(expanded).toContain('data-kanban-lane-column-count="0"');
  });

  test("renders one board row when subgrouping is absent", () => {
    const singleLaneMatrix = buildKanbanBoardMatrix({
      group,
      subgroup: noSubgroup,
      rows: [{ id: "one", owner: "ada", status: "open" }],
      uncategorizedLabel: "No value",
      resolveGroupValue: ({ grouping, row }) =>
        grouping.type === "built-in" ? row.status : row.owner,
    });
    const markup = renderBoard(singleLaneMatrix);

    expect(markup).toContain("column:open:1");
    expect(markup).toContain("cell::open:1");
    expect(markup).not.toContain("lane:");
  });
});
