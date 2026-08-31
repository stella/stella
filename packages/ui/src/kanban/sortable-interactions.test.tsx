import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import {
  getKanbanHorizontalEdge,
  KANBAN_DIRECTIONS,
  KANBAN_HORIZONTAL_EDGES,
} from "./sortable-edge";
import {
  KANBAN_MOUSE_ACTIVATION_DISTANCE,
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

describe("sortable board interactions", () => {
  test("keeps mouse and touch activation distinct from scrolling", () => {
    expect(KANBAN_MOUSE_ACTIVATION_DISTANCE).toBe(8);
    expect(KANBAN_TOUCH_ACTIVATION_CONSTRAINT).toEqual({
      delay: 150,
      tolerance: 8,
    });
  });

  test("uses the current mouse or touch coordinate to resolve the insertion edge", () => {
    expect(
      getKanbanHorizontalEdge({
        input: "pointer",
        currentClientX: 110,
        overRect: rect(100, 100),
      }),
    ).toBe(KANBAN_HORIZONTAL_EDGES.before);

    expect(
      getKanbanHorizontalEdge({
        input: "pointer",
        currentClientX: 160,
        overRect: rect(100, 100),
      }),
    ).toBe(KANBAN_HORIZONTAL_EDGES.after);
  });

  test("keeps mouse and touch edge resolution stable after horizontal scrolling", () => {
    expect(
      getKanbanHorizontalEdge({
        input: "pointer",
        currentClientX: 120,
        overRect: rect(100, 100),
      }),
    ).toBe(KANBAN_HORIZONTAL_EDGES.before);
  });

  test("uses keyboard indices for forward and backward moves", () => {
    expect(
      getKanbanHorizontalEdge({
        input: "keyboard",
        sourceIndex: 1,
        targetIndex: 2,
      }),
    ).toBe(KANBAN_HORIZONTAL_EDGES.after);

    expect(
      getKanbanHorizontalEdge({
        input: "keyboard",
        sourceIndex: 2,
        targetIndex: 1,
      }),
    ).toBe(KANBAN_HORIZONTAL_EDGES.before);
  });

  test("maps physical pointer and touch positions to logical RTL edges", () => {
    expect(
      getKanbanHorizontalEdge({
        input: "pointer",
        currentClientX: 110,
        overRect: rect(100, 100),
        direction: KANBAN_DIRECTIONS.ltr,
      }),
    ).toBe(KANBAN_HORIZONTAL_EDGES.before);

    expect(
      getKanbanHorizontalEdge({
        input: "pointer",
        currentClientX: 110,
        overRect: rect(100, 100),
        direction: KANBAN_DIRECTIONS.rtl,
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
    expect(html).toContain("touch-auto");
    expect(html).toContain("overflow-y-auto");
    expect(html).toContain("size-11 min-h-11 min-w-11 touch-none sm:size-11");
    expect(html).toContain('aria-label="Move card"');
  });
});
