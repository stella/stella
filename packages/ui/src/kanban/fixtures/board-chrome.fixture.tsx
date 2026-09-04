import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { KanbanCardShell } from "../card-shell";
import { KanbanColumnHeader } from "../column-header";
import { resolveKanbanGrouping } from "../grouping";
import type { KanbanSchema } from "../grouping";
import { buildKanbanBoardMatrix } from "../matrix";
import { KanbanSubgroupBoard } from "../subgroup-board";

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
    id === "owner" ? [{ label: "Ada", value: "ada" }] : null,
  properties: [{ id: "owner" }],
};

const rows: Row[] = [
  { id: "open-1", owner: "ada", status: "open" },
  { id: "blocked-1", owner: "ada", status: "blocked" },
  { id: "done-1", owner: "ada", status: "done" },
];

const matrix = buildKanbanBoardMatrix({
  group: resolveKanbanGrouping({ groupBy: "_status", schema }),
  subgroup: resolveKanbanGrouping({ groupBy: "owner", schema }),
  rows,
  uncategorizedLabel: "No value",
  resolveGroupValue: ({ grouping, row }) =>
    grouping.type === "built-in" ? row.status : row.owner,
});

const BoardChromeFixture = () => {
  // The card a tap opened, the way a host tracks the one whose detail is on
  // screen. It is what gives a finger its way to the hover-revealed actions.
  const [activeCardId, setActiveCardId] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.dataset["kanbanBoardChromeReady"] = "true";
    return () => {
      delete document.documentElement.dataset["kanbanBoardChromeReady"];
    };
  }, []);

  return (
    // Narrower than the board's own columns at any viewport the suite runs
    // at, so the board always has somewhere to scroll sideways to.
    <div className="h-[420px] w-[500px]">
      <KanbanSubgroupBoard
        className="fixture-board"
        isBandCollapsed={() => false}
        isLaneCollapsed={() => false}
        matrix={matrix}
        renderCell={({ cell }) => (
          <div className="flex flex-col gap-2">
            {cell.rows.map((row) => (
              <div data-card={row.id} key={row.id}>
                <KanbanCardShell
                  actions={
                    <button data-card-actions={row.id} type="button">
                      More
                    </button>
                  }
                  actionsVisibility="hover"
                  active={activeCardId === row.id}
                  onOpen={() => {
                    setActiveCardId(row.id);
                  }}
                >
                  <span className="text-xs">{row.id}</span>
                </KanbanCardShell>
              </div>
            ))}
          </div>
        )}
        renderColumnHeader={({ column }) => {
          const value = column.type === "group" ? column.group.value : null;
          const label = column.type === "group" ? column.group.label : "Other";
          return (
            // A header cell the way a host dresses one: the rounding and the
            // accent wash sit on the container around the header row, so a
            // title pinned inside that row has to let them paint through.
            <div
              className="w-full rounded-lg"
              data-column-header={value ?? "other"}
              style={
                value === "open"
                  ? {
                      backgroundColor:
                        "color-mix(in srgb, var(--option-blue) 50%, transparent)",
                    }
                  : undefined
              }
            >
              <KanbanColumnHeader
                actions={
                  <button data-column-actions={value ?? "other"} type="button">
                    More
                  </button>
                }
                meta="1"
                title={
                  <span className="truncate text-sm font-medium">{label}</span>
                }
              />
            </div>
          );
        }}
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
  createRoot(root).render(<BoardChromeFixture />);
}
