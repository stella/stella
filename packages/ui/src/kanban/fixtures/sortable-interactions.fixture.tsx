import { createRoot } from "react-dom/client";

import { panic } from "better-result";

import {
  KanbanCardDragSurface,
  KanbanDragHandle,
  KanbanSortableBoard,
  KanbanSortableColumns,
  useKanbanSortable,
} from "../sortable-interactions";
import { KanbanVirtualCell } from "../virtual-cell";

const fixtureStyles = `
  .touch-auto { touch-action: auto; }
  .touch-none { touch-action: none; }
  .size-11 { block-size: 44px; inline-size: 44px; }
  [data-board] { block-size: 300px; display: flex; inline-size: 320px; overflow-x: auto; position: relative; }
  [data-column] { flex: 0 0 200px; }
  .kanban-test-list { block-size: 120px; max-block-size: 120px; overflow-y: auto; }
  [data-sortable-item] { block-size: 96px; }
`;

const firstColumnRows = [
  { id: "first" },
  { id: "third" },
  { id: "fourth" },
  { id: "fifth" },
  { id: "sixth" },
  ...Array.from({ length: 20 }, (_, index) => ({
    id: `virtual-${index + 1}`,
  })),
];

const cells = [
  { id: "cell-a", position: { column: 0, lane: 0 }, rows: firstColumnRows },
  { id: "cell-b", position: { column: 1, lane: 0 }, rows: [] },
  {
    id: "cell-c",
    position: { column: 0, lane: 1 },
    rows: [{ id: "lane-second" }],
  },
  {
    id: "cell-d",
    position: { column: 1, lane: 1 },
    rows: [{ id: "second" }, { id: "whole-item" }],
  },
] as const;

const SortableItem = ({ id }: { id: string }) => {
  const { activator, setNodeRef, style } = useKanbanSortable({
    activation: { type: id === "whole-item" ? "card" : "handle" },
    id,
  });

  if (activator.type === "card") {
    return (
      <div data-sortable-item={id} ref={setNodeRef} style={style}>
        <KanbanCardDragSurface bindings={activator.bindings}>
          <p data-card-content="">{id}</p>
          <button data-card-control="" type="button">
            Keep {id} control interactive
          </button>
        </KanbanCardDragSurface>
      </div>
    );
  }

  if (activator.type === "handle") {
    return (
      <div data-sortable-item={id} ref={setNodeRef} style={style}>
        <KanbanDragHandle bindings={activator.bindings} label={`Move ${id}`} />
      </div>
    );
  }

  return panic("fixture cards use card or handle activation");
};

const SortableVirtualCell = ({
  id,
  position,
  rows,
}: {
  id: string;
  position: { column: number; lane: number };
  rows: readonly { id: string }[];
}) => (
  <KanbanVirtualCell
    className="kanban-test-list"
    getRowKey={({ id: rowId }) => rowId}
    pagination={{ type: "none" }}
    renderRow={({ id: rowId }) => <SortableItem id={rowId} />}
    rows={rows}
    sortable={{
      dropTarget: { id, position },
      getRowId: ({ id: rowId }) => rowId,
    }}
  />
);

const SortableFixture = () => (
  <KanbanSortableBoard
    onDragStart={() => {
      document.documentElement.dataset["dragStartedAt"] = String(
        performance.now(),
      );
    }}
    onDragEnd={({ over }) => {
      document.documentElement.dataset["droppedOn"] =
        over === null ? "" : String(over.id);
    }}
    onDragOver={({ over }) => {
      document.documentElement.dataset["draggedOver"] =
        over === null ? "" : String(over.id);
    }}
    onInteractionReady={() => {
      document.documentElement.dataset["kanbanInteractionReady"] = "true";
    }}
    overlayProps={{ dropAnimation: null }}
    overlay={(activeId) =>
      activeId === null ? null : <output data-overlay="">{activeId}</output>
    }
  >
    <style>{fixtureStyles}</style>
    <KanbanSortableColumns data-board="" items={["column-a", "column-b"]}>
      <section data-column="first">
        <div data-board-chrome="" style={{ position: "sticky", zIndex: 20 }}>
          First
        </div>
        <SortableVirtualCell {...cells[0]} />
        <SortableVirtualCell {...cells[2]} />
      </section>
      <section data-column="second">
        <SortableVirtualCell {...cells[1]} />
        <SortableVirtualCell {...cells[3]} />
      </section>
    </KanbanSortableColumns>
  </KanbanSortableBoard>
);

const root = document.querySelector("#root");

if (root) {
  createRoot(root).render(<SortableFixture />);
}
