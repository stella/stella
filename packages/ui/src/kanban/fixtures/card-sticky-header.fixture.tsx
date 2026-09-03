import { useEffect, useLayoutEffect, useRef } from "react";
import { createRoot } from "react-dom/client";

import { KanbanCardShell } from "../card-shell";
import { KanbanCellAction } from "../cell-action";
import { resolveKanbanGrouping } from "../grouping";
import type { KanbanSchema } from "../grouping";
import { buildKanbanBoardMatrix } from "../matrix";
import { KanbanSubgroupBoard } from "../subgroup-board";
import { KanbanVirtualCell } from "../virtual-cell";

type Row = { id: string };
type Property = { id: string };

const schema: KanbanSchema<Row, Property> = {
  builtInGroups: [
    { id: "_status", options: [{ label: "Open", value: "open" }] },
  ],
  getPropertyId: ({ id }) => id,
  getPropertyOptions: ({ id }) =>
    id === "owner" ? [{ label: "Ada", value: "ada" }] : null,
  properties: [{ id: "owner" }],
};

// Each card is taller than the board's viewport, so a scroll always rests
// inside one of them: exactly the case a card's identity row has to survive.
const rows: Row[] = Array.from({ length: 4 }, (_, index) => ({
  id: `card-${String(index + 1)}`,
}));

const matrix = buildKanbanBoardMatrix({
  group: resolveKanbanGrouping({ groupBy: "_status", schema }),
  subgroup: resolveKanbanGrouping({ groupBy: "owner", schema }),
  rows,
  uncategorizedLabel: "No value",
  resolveGroupValue: ({ grouping }) =>
    grouping.type === "built-in" ? "open" : "ada",
});

/**
 * Publishes what the row around it carries in the frame the browser is about
 * to paint it in. The read is scheduled from a layout effect but taken in the
 * frame's animation callback, which is the one point that is past every
 * synchronous re-render a layout effect provoked and still short of the
 * frame's resize-observation step: a cell that measures its pinned action in a
 * layout effect has published its reach by then, and a cell that leaves the
 * measurement to an observer has published nothing but the board's own offset,
 * which is exactly the frame a card's identity row spends pinned where the
 * action is about to be.
 */
const FirstLayoutProbe = () => {
  const anchor = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const frame = requestAnimationFrame(() => {
      const row = anchor.current?.closest<HTMLElement>("[data-index]");

      if (
        !row ||
        document.documentElement.dataset["kanbanCardStickyTopFirstLayout"] !==
          undefined
      ) {
        return;
      }
      document.documentElement.dataset["kanbanCardStickyTopFirstLayout"] =
        row.style.getPropertyValue("--kanban-card-sticky-top");
    });

    return () => {
      cancelAnimationFrame(frame);
    };
  }, []);

  return <span hidden ref={anchor} />;
};

const CardStickyHeaderFixture = () => {
  useEffect(() => {
    document.documentElement.dataset["kanbanCardStickyHeaderReady"] = "true";
    return () => {
      delete document.documentElement.dataset["kanbanCardStickyHeaderReady"];
      delete document.documentElement.dataset["kanbanCardStickyTopFirstLayout"];
    };
  }, []);

  return (
    <div className="h-[420px]">
      <KanbanSubgroupBoard
        className="fixture-board"
        isBandCollapsed={() => false}
        isLaneCollapsed={() => false}
        matrix={matrix}
        renderCell={({ cell }) => (
          <KanbanVirtualCell
            // The lane, not the cell, owns the scroll here: the board's header
            // and the cell's pinned action both sit above the cards.
            className="max-h-none overflow-y-visible"
            estimateSize={600}
            footer={<KanbanCellAction>Add card</KanbanCellAction>}
            footerPlacement="sticky-start"
            getRowKey={(row) => row.id}
            pagination={{ type: "none" }}
            renderRow={(row) => (
              <div data-card={row.id}>
                <KanbanCardShell
                  // The overlay slot callers anchor to the same corner the
                  // identity row leads: it has to stay on top of the row.
                  actions={
                    <div className="absolute end-1.5 top-1.5">
                      <button data-card-actions={row.id} type="button">
                        More
                      </button>
                    </div>
                  }
                  className="h-[600px]"
                  stickyHeader={
                    <div
                      className="text-xs font-medium"
                      data-card-title={row.id}
                    >
                      {row.id}
                    </div>
                  }
                >
                  <p className="text-muted-foreground text-xs">
                    A card far taller than the board it scrolls through.
                  </p>
                  {row.id === "card-1" ? <FirstLayoutProbe /> : null}
                </KanbanCardShell>
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
  createRoot(root).render(<CardStickyHeaderFixture />);
}
