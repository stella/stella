import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { KanbanColumnBandHeader } from "./column-band-header";
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
    // Only the collapsed (empty) lanes carry a count row; the open lane
    // shows its cells instead.
    expect(collapsed).toContain('data-kanban-lane-column-count="0"');
    expect(collapsed).not.toContain('data-kanban-lane-column-count="1"');
    expect(collapsed).not.toContain("cell:lin:open:0");
    expect(collapsed).toContain('aria-expanded="false"');
    expect(expanded).toContain("cell:lin:open:0");
    expect(expanded).toContain("cell:lin:done:0");
    // An open lane shows its cells; the count row stands in only while
    // the lane is collapsed.
    expect(expanded).not.toContain("data-kanban-lane-column-count");
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

  test("renders no band chrome when no column carries a band", () => {
    expect(renderBoard()).not.toContain("data-kanban-band");
  });
});

describe("KanbanColumnBandHeader", () => {
  // A collapsed band that peeks open under the pointer keeps reporting
  // itself collapsed: its toggle offers to pin it open, never to close it,
  // so a click on a peeked band does not fold it straight back.
  test("shows the full caption for a peeked band with an expand toggle", () => {
    const markup = renderToStaticMarkup(
      <KanbanColumnBandHeader
        collapsed
        compact={false}
        meta="2"
        title="To do"
        toggleLabel="Expand To do"
        onCollapsedChange={() => undefined}
      />,
    );

    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-label="Expand To do"');
    expect(markup).toContain(">To do<");
    expect(markup).not.toContain('data-compact=""');
  });

  test("keeps only the toggle in the narrow slot of a folded band", () => {
    const markup = renderToStaticMarkup(
      <KanbanColumnBandHeader
        collapsed
        title="To do"
        toggleLabel="Expand To do"
        onCollapsedChange={() => undefined}
      />,
    );

    expect(markup).toContain('data-compact=""');
    expect(markup).not.toContain(">To do<");
  });
});

describe("KanbanSubgroupBoard with column bands", () => {
  const todo = { id: "todo", label: "To do" };
  const bandedSchema: KanbanSchema<Row, Property> = {
    ...schema,
    builtInGroups: [
      {
        id: "_status",
        options: [
          { band: todo, label: "Open", value: "open" },
          { band: todo, label: "Blocked", value: "blocked" },
          { label: "Done", value: "done" },
        ],
      },
    ],
  };
  const bandedGroup = resolveKanbanGrouping({
    groupBy: "_status",
    schema: bandedSchema,
  });
  const bandedMatrix = buildKanbanBoardMatrix({
    group: bandedGroup,
    subgroup: resolveKanbanGrouping({ groupBy: "owner", schema: bandedSchema }),
    rows: [
      { id: "one", owner: "ada", status: "open" },
      { id: "two", owner: "ada", status: "blocked" },
      { id: "three", owner: "ada", status: "done" },
    ],
    uncategorizedLabel: "No value",
    resolveGroupValue: ({ grouping, row }) =>
      grouping.type === "built-in" ? row.status : row.owner,
  });
  const renderBanded = (collapsed: boolean) =>
    renderToStaticMarkup(
      <KanbanSubgroupBoard
        formatBandToggleLabel={(band, isCollapsed) =>
          `${isCollapsed ? "Expand" : "Collapse"} ${band.label}`
        }
        isBandCollapsed={(band) => collapsed && band.id === "todo"}
        isLaneCollapsed={() => false}
        matrix={bandedMatrix}
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
        renderCollapsedBandCell={({ band, cells, count, laneValue }) => (
          <span>
            {testLabel("folded", laneValue, band.id, cells.length, count)}
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
        onBandCollapsedChange={() => undefined}
        onLaneCollapsedChange={() => undefined}
      />,
    );

  test("draws one band header over the band's columns with their total", () => {
    const markup = renderBanded(false);

    expect(markup).toContain('data-kanban-band-row=""');
    expect(markup.match(/data-kanban-band="todo"/gu)?.length).toBeGreaterThan(
      0,
    );
    expect(markup).toContain('aria-label="Collapse To do"');
    expect(markup).toContain(">To do<");
    // Two cards across open and blocked; the un-banded Done column has none.
    expect(markup).toContain('data-slot="kanban-column-band-header"');
    expect(markup).toContain("column:open:1");
    expect(markup).toContain("column:blocked:1");
    expect(markup).toContain("cell:ada:open:1");
    expect(markup).toContain("cell:ada:blocked:1");
    expect(markup).toContain("cell:ada:done:1");
  });

  test("keeps the band line one caption tall and moves a folded name into the body", () => {
    const open = renderBanded(false);
    const folded = renderToStaticMarkup(
      <KanbanSubgroupBoard
        isBandCollapsed={(band) => band.id === "todo"}
        isLaneCollapsed={() => false}
        matrix={bandedMatrix}
        renderCell={() => <span>cell</span>}
        renderColumnHeader={() => <span>column</span>}
        renderLaneIdentity={() => <span>lane</span>}
        onBandCollapsedChange={() => undefined}
        onLaneCollapsedChange={() => undefined}
      />,
    );

    // The caption line is a fixed 28px row with a hairline, not a boxed panel.
    expect(open).toContain('data-slot="kanban-column-band-header"');
    expect(open).toMatch(
      /class="[^"]*\bh-7\b[^"]*"[^>]*data-slot="kanban-column-band-header"/u,
    );
    expect(open).not.toContain("rounded-lg border");
    // Folded, the caption keeps only the toggle; the name sits vertically in
    // the default body slot with the count under it.
    const foldedHeader =
      /<div[^>]*data-slot="kanban-column-band-header"[^>]*>[\s\S]*?<\/div>/u.exec(
        folded,
      )?.[0] ?? "";
    expect(foldedHeader).toContain('aria-expanded="false"');
    expect(foldedHeader).not.toContain(">To do<");
    expect(folded).toContain("[writing-mode:vertical-rl]");
    expect(folded).toContain('data-kanban-collapsed-band-count="2"');
  });

  test("folds a collapsed band into one slot per row and keeps its cells reachable", () => {
    const markup = renderBanded(true);

    expect(markup).toContain('data-kanban-band-collapsed=""');
    expect(markup).toContain('aria-label="Expand To do"');
    // The band's column headers and cells are gone from the flow...
    expect(markup).not.toContain("column:open:1");
    expect(markup).not.toContain("cell:ada:open:1");
    // ...replaced by one folded slot per lane carrying both hidden cells;
    // the slot carries its own count, so the open lane adds no count row.
    expect(markup).toContain("folded:ada:todo:2:2");
    expect(markup).not.toContain("data-kanban-lane-column-count");
    // Columns outside the band are untouched.
    expect(markup).toContain("column:done:1");
    expect(markup).toContain("cell:ada:done:1");
  });
});
