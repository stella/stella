import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import {
  getKanbanHorizontalEdge,
  KANBAN_HORIZONTAL_EDGES,
} from "./sortable-edge";
import {
  KANBAN_POINTER_ACTIVATION_DISTANCE,
  KANBAN_TOUCH_ACTIVATION_CONSTRAINT,
  KanbanDragHandle,
  KanbanSortableColumns,
  KanbanSortableList,
} from "./sortable-interactions";

const rect = (left: number, width: number) => ({
  left,
  width,
  top: 0,
  height: 0,
  right: left + width,
  bottom: 0,
});

class ClientXEvent extends Event {
  readonly clientX: number;

  constructor(type: string, clientX: number) {
    super(type);
    this.clientX = clientX;
  }
}

class TouchClientXEvent extends Event {
  readonly changedTouches: {
    item: (index: number) => { clientX: number } | null;
  };
  readonly touches: { item: (index: number) => { clientX: number } | null };

  constructor(clientX: number) {
    super("touchstart");
    const touch = { clientX };
    const touches = { item: (index: number) => (index === 0 ? touch : null) };
    this.changedTouches = touches;
    this.touches = touches;
  }
}

describe("sortable board interactions", () => {
  test("keeps pointer and touch activation distinct from scrolling", () => {
    expect(KANBAN_POINTER_ACTIVATION_DISTANCE).toBe(8);
    expect(KANBAN_TOUCH_ACTIVATION_CONSTRAINT).toEqual({
      delay: 150,
      tolerance: 8,
    });
  });

  test("uses the grab point plus pointer movement to resolve the insertion edge", () => {
    expect(
      getKanbanHorizontalEdge({
        activatorEvent: new ClientXEvent("pointerdown", 110),
        deltaX: 20,
        activeRect: null,
        overRect: rect(100, 100),
      }),
    ).toBe(KANBAN_HORIZONTAL_EDGES.before);

    expect(
      getKanbanHorizontalEdge({
        activatorEvent: new ClientXEvent("pointerdown", 110),
        deltaX: 50,
        activeRect: null,
        overRect: rect(100, 100),
      }),
    ).toBe(KANBAN_HORIZONTAL_EDGES.after);
  });

  test("uses the touch grab point and keyboard item's center when no point exists", () => {
    expect(
      getKanbanHorizontalEdge({
        activatorEvent: new TouchClientXEvent(120),
        deltaX: 10,
        activeRect: null,
        overRect: rect(100, 100),
      }),
    ).toBe(KANBAN_HORIZONTAL_EDGES.before);

    expect(
      getKanbanHorizontalEdge({
        activatorEvent: new Event("keydown"),
        deltaX: 0,
        activeRect: rect(160, 40),
        overRect: rect(100, 100),
      }),
    ).toBe(KANBAN_HORIZONTAL_EDGES.after);
  });

  test("keeps touch-none on the 44px activator, not either scroll container", () => {
    const html = renderToStaticMarkup(
      <KanbanSortableColumns items={["column"]}>
        <KanbanSortableList items={["card"]}>
          <KanbanDragHandle
            bindings={{
              attributes: {
                "aria-describedby": "sortable-description",
                "aria-disabled": false,
                "aria-pressed": undefined,
                "aria-roledescription": "sortable",
                role: "button",
                tabIndex: 0,
              },
              listeners: undefined,
              setActivatorNodeRef: () => undefined,
            }}
            label="Move card"
          />
        </KanbanSortableList>
      </KanbanSortableColumns>,
    );

    expect(html).toContain("overflow-x-auto");
    expect(html).toContain("touch-pan-x");
    expect(html).toContain("overflow-y-auto");
    expect(html).toContain("touch-pan-y");
    expect(html).toContain("size-11 touch-none");
    expect(html).toContain('aria-label="Move card"');
  });
});
