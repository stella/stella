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
        currentClientX: 110,
        translatedActiveRect: rect(600, 100),
        overRect: rect(100, 100),
      }),
    ).toBe(KANBAN_HORIZONTAL_EDGES.before);

    expect(
      getKanbanHorizontalEdge({
        currentClientX: 160,
        translatedActiveRect: rect(600, 100),
        overRect: rect(100, 100),
      }),
    ).toBe(KANBAN_HORIZONTAL_EDGES.after);
  });

  test("keeps mouse and touch edge resolution stable after horizontal scrolling", () => {
    expect(
      getKanbanHorizontalEdge({
        currentClientX: 120,
        translatedActiveRect: rect(-400, 100),
        overRect: rect(100, 100),
      }),
    ).toBe(KANBAN_HORIZONTAL_EDGES.before);
  });

  test("uses the translated keyboard item's center without a client coordinate", () => {
    expect(
      getKanbanHorizontalEdge({
        translatedActiveRect: rect(160, 40),
        overRect: rect(100, 100),
      }),
    ).toBe(KANBAN_HORIZONTAL_EDGES.after);
  });

  test("uses keyboard indices for equal-center forward and backward moves", () => {
    expect(
      getKanbanHorizontalEdge({
        translatedActiveRect: rect(100, 100),
        overRect: rect(100, 100),
        sourceIndex: 1,
        targetIndex: 2,
      }),
    ).toBe(KANBAN_HORIZONTAL_EDGES.after);

    expect(
      getKanbanHorizontalEdge({
        translatedActiveRect: rect(100, 100),
        overRect: rect(100, 100),
        sourceIndex: 2,
        targetIndex: 1,
      }),
    ).toBe(KANBAN_HORIZONTAL_EDGES.before);
  });

  test("maps physical pointer and touch positions to logical RTL edges", () => {
    expect(
      getKanbanHorizontalEdge({
        currentClientX: 110,
        translatedActiveRect: rect(100, 100),
        overRect: rect(100, 100),
        direction: KANBAN_DIRECTIONS.ltr,
      }),
    ).toBe(KANBAN_HORIZONTAL_EDGES.before);

    expect(
      getKanbanHorizontalEdge({
        currentClientX: 110,
        translatedActiveRect: rect(100, 100),
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
    expect(html).toContain("size-11 touch-none");
    expect(html).toContain('aria-label="Move card"');
  });
});
