import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { KanbanColumnBandHeader } from "./column-band-header";
import type { KanbanSchema } from "./grouping";
import { resolveKanbanGrouping } from "./grouping";
import { KANBAN_CHROME_ROW_HEIGHT } from "./layout-tokens";
import { buildKanbanBoardMatrix } from "./matrix";
import { KANBAN_STICKY_TOP_CLASS, KANBAN_STICKY_TOP_VAR } from "./sticky-lane";
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
    expect(collapsed).not.toContain("cell:lin:open:0");
    expect(collapsed).toContain('aria-expanded="false"');
    expect(expanded).toContain("cell:lin:open:0");
    expect(expanded).toContain("cell:lin:done:0");
    // A lane's summaries stand beside its cells rather than in place of
    // them, so an open lane carries them too: the row is pinned, and it is
    // what tells a reader deep in a lane what each column holds.
    expect(collapsed).toContain('data-kanban-lane-column-count="0"');
    expect(expanded).toContain('data-kanban-lane-column-count="1"');
  });

  test("pins a lane's row on both axes and offsets its cells by it", () => {
    const markup = renderBoard(matrix, true);
    const laneRow =
      /<div[^>]*data-kanban-lane-row=""[^>]*>/u.exec(markup)?.[0] ?? "";

    // Under the board's header, and below it: the header is z-20.
    expect(laneRow).toContain("sticky");
    expect(laneRow).toContain(KANBAN_STICKY_TOP_CLASS);
    expect(laneRow).toContain("z-10");
    // Opaque, or the cards it holds back read through it.
    expect(laneRow).toContain("bg-background");
    // The identity holds the visible inline edge, and has to size to its own
    // content to have any room to travel there.
    expect(markup).toContain("sticky start-0 flex w-fit");
    // The cells are told what the header *and* the lane row reach, or a
    // card's own pinned row would come to rest behind the lane's.
    expect(markup).toContain(`${KANBAN_STICKY_TOP_VAR}:72px`);
  });

  test("gives the lane toggle a finger's target on the 36px chrome row", () => {
    const markup = renderBoard(matrix, true);
    const toggle = /<button[^>]*aria-expanded="true"[^>]*>/u.exec(markup)?.[0];

    // The row is fixed at 36px, under Stella's 44px minimum, so the toggle
    // extends its touch surface the way the shared button does rather than
    // growing the visible control and taking the row off the board's rhythm.
    expect(toggle).toContain(KANBAN_CHROME_ROW_HEIGHT);
    expect(toggle).toContain("relative");
    expect(toggle).toContain("pointer-coarse:after:absolute");
    expect(toggle).toContain("pointer-coarse:after:min-h-11");
    // Centred on the toggle: growing downwards alone would reach into the
    // summaries row under it.
    expect(toggle).toContain("pointer-coarse:after:-inset-y-1");
  });

  test("hands a lane's per-column cell to the caller's summary and action", () => {
    const markup = renderToStaticMarkup(
      <KanbanSubgroupBoard
        isLaneCollapsed={() => false}
        matrix={matrix}
        renderCell={() => <span>cell</span>}
        renderColumnHeader={() => <span>column</span>}
        renderLaneColumnAction={({ column, lane }) => (
          <button type="button">
            {testLabel(
              "add",
              lane.value,
              column.type === "group" ? column.group.value : "other",
            )}
          </button>
        )}
        renderLaneColumnSummary={({ column, count, lane }) => (
          <span>
            {testLabel(
              "summary",
              lane.value,
              column.type === "group" ? column.group.value : "other",
              count,
            )}
          </span>
        )}
        renderLaneIdentity={({ group: lane }) => <span>{lane.label}</span>}
        onLaneCollapsedChange={() => undefined}
      />,
    );

    expect(markup).toContain("summary:ada:open:1");
    expect(markup).toContain("add:ada:open");
    // The caller's summary replaces the default count rather than joining it.
    expect(markup).not.toContain(
      '<span class="text-muted-foreground text-xs tabular-nums">1</span></div>',
    );
    // Summary first, the action pushed to the cell's end.
    expect(markup.indexOf("summary:ada:open:1")).toBeLessThan(
      markup.indexOf("add:ada:open"),
    );
    expect(markup).toContain("ms-auto");
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

  test("publishes the sticky header's reach on its scroll container", () => {
    // Nothing is measured before the board is in a document, so the offset
    // starts at zero rather than leaving the property undeclared.
    expect(renderBoard()).toContain(`${KANBAN_STICKY_TOP_VAR}:0px`);
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

  test("keeps an open band's caption at the visible edge of its own band", () => {
    const markup = renderBanded(false);
    const caption =
      /<div[^>]*data-kanban-band-caption=""[^>]*>/u.exec(markup)?.[0] ?? "";

    expect(caption).toContain("sticky");
    expect(caption).toContain("start-0");
    // Sized to its content, or it fills the band's header cell and has no
    // room to travel at all; bounded by the band, past which a caption for
    // that band means nothing.
    expect(caption).toContain("w-fit");
    expect(caption).toContain("max-w-full");
    // It slides over its own band's columns, so it cannot be transparent.
    expect(caption).toContain("bg-background");
  });

  test("keeps a folded band's caption under the header down its lane", () => {
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
    const slot =
      /<div[^>]*data-kanban-collapsed-band-count="2"[^>]*>/u.exec(
        folded,
      )?.[0] ?? "";

    // The slot fills the lane, which is the height the caption travels
    // through; the caption itself sticks under the board's header.
    expect(slot).toContain("h-full");
    expect(slot).toContain("flex-col");
    expect(folded).toContain('data-kanban-collapsed-band-caption=""');
    expect(folded).toContain(`top-(${KANBAN_STICKY_TOP_VAR},0px)`);
  });

  test("folds a collapsed band into one slot per row and keeps its cells reachable", () => {
    const markup = renderBanded(true);

    expect(markup).toContain('data-kanban-band-collapsed=""');
    expect(markup).toContain('aria-label="Expand To do"');
    // The band's column headers and cells are gone from the flow...
    expect(markup).not.toContain("column:open:1");
    expect(markup).not.toContain("cell:ada:open:1");
    // ...replaced by one folded slot per lane carrying both hidden cells,
    // and by a single centred total in the lane's row, since one slot cannot
    // carry the per-column pair the open columns show.
    expect(markup).toContain("folded:ada:todo:2:2");
    expect(markup).toMatch(
      /data-kanban-band-collapsed=""><div class="[^"]*justify-center[^"]*" data-kanban-lane-column-count="2"/u,
    );
    // Columns outside the band are untouched.
    expect(markup).toContain("column:done:1");
    expect(markup).toContain("cell:ada:done:1");
  });
});
