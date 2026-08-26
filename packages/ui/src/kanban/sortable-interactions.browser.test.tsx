import { act } from "react";
import { createRoot } from "react-dom/client";

import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

import {
  KanbanDragHandle,
  KanbanSortableBoard,
  KanbanSortableColumns,
  useKanbanSortable,
} from "./sortable-interactions";

const domWindow = new Window({ url: "http://localhost" });

Object.assign(globalThis, {
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  Element: domWindow.Element,
  Event: domWindow.Event,
  KeyboardEvent: domWindow.KeyboardEvent,
  MouseEvent: domWindow.MouseEvent,
  MutationObserver: domWindow.MutationObserver,
  PointerEvent: domWindow.PointerEvent,
  Touch: domWindow.Touch,
  TouchEvent: domWindow.TouchEvent,
  document: domWindow.document,
  getComputedStyle: domWindow.getComputedStyle.bind(domWindow),
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
  cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
  window: domWindow,
  IS_REACT_ACT_ENVIRONMENT: true,
});

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

const render = () => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  try {
    act(() => root?.render(<SortableFixture />));
  } catch (error) {
    if (error instanceof AggregateError) {
      const first = error.errors.at(0);
      if (first) {
        throw first;
      }
    }
    throw error;
  }
  return container;
};

const SortableFixture = () => (
  <KanbanSortableBoard
    onDragEnd={() => undefined}
    overlayProps={{ dropAnimation: null }}
    overlay={(activeId) =>
      activeId === null ? null : <output data-overlay="">{activeId}</output>
    }
  >
    <KanbanSortableColumns items={["first", "second"]}>
      <SortableItem id="first" />
      <SortableItem id="second" />
    </KanbanSortableColumns>
  </KanbanSortableBoard>
);

const SortableItem = ({ id }: { id: string }) => {
  const { dragHandle, setNodeRef, style } = useKanbanSortable({ id });

  return (
    <div data-sortable-item={id} ref={(node) => setNodeRef(node)} style={style}>
      <KanbanDragHandle bindings={dragHandle} label={`Move ${id}`} />
    </div>
  );
};

const getHandle = (label: string) => {
  const element = document.querySelector(`[aria-label="${label}"]`);
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error(`Missing drag handle: ${label}`);
  }
  return element;
};

describe("sortable board browser interactions", () => {
  test("activates a pointer drag only after moving past the distance threshold", () => {
    render();
    const handle = getHandle("Move first");

    act(() => {
      handle.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          clientX: 10,
          isPrimary: true,
          pointerId: 1,
          pointerType: "mouse",
        }),
      );
      document.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          clientX: 17,
          isPrimary: true,
          pointerId: 1,
          pointerType: "mouse",
        }),
      );
    });

    expect(document.querySelector("[data-overlay]")).toBeNull();

    act(() => {
      document.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          clientX: 19,
          isPrimary: true,
          pointerId: 1,
          pointerType: "mouse",
        }),
      );
    });

    expect(document.querySelector("[data-overlay]")?.textContent).toBe("first");

    act(() => {
      document.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          clientX: 19,
          isPrimary: true,
          pointerId: 1,
          pointerType: "mouse",
        }),
      );
    });
  });

  test("activates a touch drag after the touch delay", async () => {
    render();
    const handle = getHandle("Move first");
    const touch = new Touch({
      identifier: 1,
      target: handle,
      clientX: 10,
      clientY: 10,
    });

    act(() => {
      handle.dispatchEvent(
        new TouchEvent("touchstart", {
          bubbles: true,
          changedTouches: [touch],
          touches: [touch],
        }),
      );
    });

    await act(async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 170);
      });
    });

    expect(document.querySelector("[data-overlay]")?.textContent).toBe("first");

    act(() => {
      handle.dispatchEvent(
        new TouchEvent("touchend", {
          bubbles: true,
          changedTouches: [touch],
          touches: [],
        }),
      );
    });
  });

  test("starts a keyboard drag from the handle", () => {
    render();
    const handle = getHandle("Move first");
    handle.focus();

    act(() => {
      handle.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, code: "Space" }),
      );
    });
    expect(document.querySelector("[data-overlay]")?.textContent).toBe("first");
  });
});
