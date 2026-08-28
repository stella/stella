import { createRoot } from "react-dom/client";

import {
  KanbanDragHandle,
  KanbanSortableBoard,
  KanbanSortableColumns,
  useKanbanSortable,
} from "../sortable-interactions";
import { KanbanVirtualCell } from "../virtual-cell";

const fixtureStyles = `
  .touch-auto { touch-action: auto; }
  .touch-none { touch-action: none; }
  [data-board] { block-size: 180px; display: flex; inline-size: 320px; overflow-x: auto; }
  [data-column] { flex: 0 0 200px; }
  .kanban-test-list { block-size: 120px; max-block-size: 120px; overflow-y: auto; }
  [data-sortable-item] { block-size: 96px; }
`;

const firstColumnRows = [{ id: "first" }, { id: "third" }, { id: "fourth" }];

const secondColumnRows = [{ id: "second" }];

const SortableItem = ({ id }: { id: string }) => {
  const { dragHandle, setNodeRef, style } = useKanbanSortable({ id });

  return (
    <div data-sortable-item={id} ref={setNodeRef} style={style}>
      <KanbanDragHandle bindings={dragHandle} label={`Move ${id}`} />
    </div>
  );
};

const SortableVirtualCell = ({ rows }: { rows: readonly { id: string }[] }) => (
  <KanbanVirtualCell
    className="kanban-test-list"
    getRowKey={({ id }) => id}
    pagination={{ type: "none" }}
    renderRow={({ id }) => <SortableItem id={id} />}
    rows={rows}
    sortable={{ getRowId: ({ id }) => id }}
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
    overlayProps={{ dropAnimation: null }}
    overlay={(activeId) =>
      activeId === null ? null : <output data-overlay="">{activeId}</output>
    }
  >
    <style>{fixtureStyles}</style>
    <KanbanSortableColumns
      data-board=""
      items={["first-column", "second-column"]}
    >
      <section data-column="first">
        <SortableVirtualCell rows={firstColumnRows} />
      </section>
      <section data-column="second">
        <SortableVirtualCell rows={secondColumnRows} />
      </section>
    </KanbanSortableColumns>
  </KanbanSortableBoard>
);

const root = document.querySelector("#root");

if (root) {
  createRoot(root).render(<SortableFixture />);
}
