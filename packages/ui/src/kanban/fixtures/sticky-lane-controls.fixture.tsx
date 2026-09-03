import { useEffect } from "react";
import { createRoot } from "react-dom/client";

import { KanbanCellAction } from "../cell-action";
import { resolveKanbanGrouping } from "../grouping";
import type { KanbanSchema } from "../grouping";
import { buildKanbanBoardMatrix } from "../matrix";
import { KanbanSubgroupBoard } from "../subgroup-board";
import { KanbanVirtualCell } from "../virtual-cell";

type Row = { id: string; owner: string; status: string };
type Property = { id: string };

const band = { id: "todo", label: "To do" };

const schema: KanbanSchema<Row, Property> = {
  builtInGroups: [
    {
      id: "_status",
      options: [
        { band, label: "Open", value: "open" },
        { band, label: "Blocked", value: "blocked" },
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

const laneRows = (owner: string, status: string, count: number): Row[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `${owner}-${status}-${String(index + 1)}`,
    owner,
    status,
  }));

// Both lanes are far taller than the board's viewport, so a scroll can rest
// inside either one; the banded columns hold enough rows for the folded slot
// to carry a count. The "none" rows fill the uncategorized column, whose
// cells take no accent: a pinned action there stands on the neutral surface.
const rows: Row[] = [
  ...laneRows("ada", "done", 40),
  ...laneRows("ada", "none", 40),
  ...laneRows("lin", "done", 40),
  ...laneRows("lin", "none", 40),
  { id: "ada-open", owner: "ada", status: "open" },
  { id: "ada-blocked", owner: "ada", status: "blocked" },
  { id: "lin-open", owner: "lin", status: "open" },
];

const matrix = buildKanbanBoardMatrix({
  group: resolveKanbanGrouping({ groupBy: "_status", schema }),
  subgroup: resolveKanbanGrouping({ groupBy: "owner", schema }),
  rows,
  uncategorizedLabel: "No value",
  resolveGroupValue: ({ grouping, row }) =>
    grouping.type === "built-in" ? row.status : row.owner,
});

const StickyLaneControlsFixture = () => {
  useEffect(() => {
    document.documentElement.dataset["kanbanStickyLaneReady"] = "true";
    return () => {
      delete document.documentElement.dataset["kanbanStickyLaneReady"];
    };
  }, []);

  return (
    <div className="h-[420px]">
      <KanbanSubgroupBoard
        className="fixture-board"
        isBandCollapsed={() => true}
        isLaneCollapsed={() => false}
        matrix={matrix}
        renderCell={({ cell }) => (
          <KanbanVirtualCell
            accent={
              cell.coordinate.column.type === "group" &&
              cell.coordinate.column.group.value !== null
                ? "blue"
                : undefined
            }
            // The lane, not the cell, owns the scroll here: this is the tall
            // cell the pinned action has to survive.
            className="max-h-none overflow-y-visible"
            footer={<KanbanCellAction>Add card</KanbanCellAction>}
            footerPlacement="sticky-start"
            getRowKey={(row) => row.id}
            pagination={{ type: "none" }}
            renderRow={(row) => (
              <div
                className="bg-card h-24 rounded-lg border p-2 text-xs"
                data-card={row.id}
              >
                {row.id}
              </div>
            )}
            rows={cell.rows}
          />
        )}
        renderColumnHeader={({ column }) => (
          <div className="text-sm font-medium">
            {column.type === "group" ? column.group.label : "Other"}
          </div>
        )}
        renderLaneIdentity={({ group }) => (
          <span data-lane={group.value}>{group.label}</span>
        )}
        onBandCollapsedChange={() => undefined}
        onLaneCollapsedChange={() => undefined}
      />
    </div>
  );
};

const root = document.querySelector("#root");

if (root) {
  createRoot(root).render(<StickyLaneControlsFixture />);
}
