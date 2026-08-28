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
const testLabel = (...values: readonly unknown[]) => values.join(":");
const matrix = buildKanbanBoardMatrix({
  group,
  subgroup,
  rows: [{ id: "one", owner: "ada", status: "open" }],
  uncategorizedLabel: "No value",
  resolveGroupValue: ({ grouping, row }) =>
    grouping.type === "built-in" ? row.status : row.owner,
});

const renderBoard = (expandEmptyLanes = false) =>
  renderToStaticMarkup(
    <KanbanSubgroupBoard
      {...(expandEmptyLanes
        ? {
            isLaneCollapsed: () => false,
            onLaneCollapsedChange: () => undefined,
          }
        : {})}
      matrix={matrix}
      renderCell={({ cell, laneValue }) => (
        <span>
          {testLabel(
            "cell",
            laneValue,
            cell.coordinate.column.value,
            cell.rows.length,
          )}
        </span>
      )}
      renderColumnHeader={({ column, count }) => (
        <span>{testLabel("column", column.value, count)}</span>
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
    const expanded = renderBoard(true);

    expect(collapsed).toContain("lane:lin:0");
    expect(collapsed).not.toContain("cell:lin:open:0");
    expect(collapsed).toContain('aria-expanded="false"');
    expect(expanded).toContain("cell:lin:open:0");
    expect(expanded).toContain("cell:lin:done:0");
  });
});
