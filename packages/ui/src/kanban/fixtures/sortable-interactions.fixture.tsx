import { createRoot } from "react-dom/client";

import {
  KanbanDragHandle,
  KanbanSortableBoard,
  KanbanSortableColumns,
  KanbanSortableList,
  useKanbanSortable,
} from "../sortable-interactions";

const fixtureStyles = `
  .touch-auto { touch-action: auto; }
  .touch-none { touch-action: none; }
  [data-board] { block-size: 180px; display: flex; inline-size: 320px; overflow-x: auto; }
  [data-column] { flex: 0 0 500px; }
  [data-list] { block-size: 120px; overflow-y: auto; }
  [data-sortable-item] { block-size: 96px; }
`;

const SortableItem = ({ id }: { id: string }) => {
  const { dragHandle, setNodeRef, style } = useKanbanSortable({ id });

  return (
    <div data-sortable-item={id} ref={setNodeRef} style={style}>
      <KanbanDragHandle bindings={dragHandle} label={`Move ${id}`} />
    </div>
  );
};

const SortableFixture = () => (
  <KanbanSortableBoard
    onDragStart={() => {
      document.documentElement.dataset["dragStartedAt"] = String(
        performance.now(),
      );
    }}
    onDragEnd={() => undefined}
    overlayProps={{ dropAnimation: null }}
    overlay={(activeId) =>
      activeId === null ? null : <output data-overlay="">{activeId}</output>
    }
  >
    <style>{fixtureStyles}</style>
    <KanbanSortableColumns data-board="" items={["column"]}>
      <section data-column="">
        <KanbanSortableList data-list="" items={["first", "second"]}>
          <SortableItem id="first" />
          <SortableItem id="second" />
        </KanbanSortableList>
      </section>
    </KanbanSortableColumns>
  </KanbanSortableBoard>
);

const root = document.querySelector("#root");

if (root) {
  createRoot(root).render(<SortableFixture />);
}
