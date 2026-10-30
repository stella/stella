import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import type { BoxDragAdjustment } from "@/hooks/use-box-drag";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/" });

const { useState } = await import("react");
const { cleanup, fireEvent, render } = await import("@testing-library/react");
const { useBoxDrag } = await import("@/hooks/use-box-drag");

afterEach(cleanup);
afterAll(async () => {
  await unregisterDomEnvironment();
});

const Harness = () => {
  const [box, setBox] = useState({ x: 0.2, y: 0.3 });
  const { startDrag, ...handlers } = useBoxDrag({
    adjust: ({
      box: initial,
      delta,
      mode,
    }: BoxDragAdjustment<typeof box, "move" | "resize">) => ({
      x: initial.x + delta.x,
      y: initial.y + (mode === "move" ? delta.y : -delta.y),
    }),
    box,
    onChange: setBox,
  });
  return (
    <div data-testid="surface">
      <button
        {...handlers}
        onPointerDown={(event) => {
          const surface = event.currentTarget.parentElement;
          if (surface) {
            startDrag(event, {
              mode: event.shiftKey ? "resize" : "move",
              surface,
            });
          }
        }}
        type="button"
      >
        {`${box.x.toFixed(3)},${box.y.toFixed(3)}`}
      </button>
    </div>
  );
};

const setup = () => {
  const view = render(<Harness />);
  const button = view.getByRole("button");
  const captured: number[] = [];
  Object.assign(button, {
    setPointerCapture: (pointerId: number) => captured.push(pointerId),
  });
  const surface = view.getByTestId("surface");
  Object.assign(surface, {
    getBoundingClientRect: () => new DOMRect(0, 0, 200, 100),
  });
  return { button, captured, surface };
};

test("normalizes deltas to the starting surface and keeps the starting box across renders", () => {
  const { button, captured, surface } = setup();
  fireEvent.pointerDown(button, {
    button: 0,
    clientX: 10,
    clientY: 20,
    pointerId: 7,
  });
  expect(captured).toEqual([7]);
  expect(document.activeElement).toBe(button);
  fireEvent.pointerMove(button, { clientX: 30, clientY: 30, pointerId: 8 });
  expect(button.textContent).toBe("0.200,0.300");
  fireEvent.pointerMove(button, { clientX: 30, clientY: 30, pointerId: 7 });
  expect(button.textContent).toBe("0.300,0.400");
  Object.assign(surface, {
    getBoundingClientRect: () => new DOMRect(0, 0, 400, 200),
  });
  fireEvent.pointerMove(button, { clientX: 50, clientY: 40, pointerId: 7 });
  expect(button.textContent).toBe("0.400,0.500");
});

const DRAG_END_EVENTS = {
  release: "pointerUp",
  cancel: "pointerCancel",
  captureLost: "lostPointerCapture",
} as const;

test.each(Object.values(DRAG_END_EVENTS))(
  "%s ends only the captured pointer's drag",
  (ending) => {
    const { button } = setup();
    fireEvent.pointerDown(button, {
      button: 0,
      clientX: 0,
      clientY: 0,
      pointerId: 7,
    });
    fireEvent[ending](button, { pointerId: 8 });
    fireEvent.pointerMove(button, { clientX: 20, clientY: 10, pointerId: 7 });
    const changed = button.textContent;
    expect(changed).toBe("0.300,0.400");
    fireEvent[ending](button, { pointerId: 7 });
    fireEvent.pointerMove(button, { clientX: 40, clientY: 20, pointerId: 7 });
    expect(button.textContent).toBe(changed);
  },
);

test("ignores secondary buttons and retains the adjustment mode chosen at drag start", () => {
  const { button, captured } = setup();
  fireEvent.pointerDown(button, {
    button: 2,
    clientX: 0,
    clientY: 0,
    pointerId: 7,
  });
  fireEvent.pointerMove(button, { clientX: 20, clientY: 10, pointerId: 7 });
  expect(captured).toEqual([]);
  expect(button.textContent).toBe("0.200,0.300");
  fireEvent.pointerDown(button, {
    button: 0,
    clientX: 0,
    clientY: 0,
    pointerId: 7,
    shiftKey: true,
  });
  fireEvent.pointerMove(button, { clientX: 20, clientY: 10, pointerId: 7 });
  expect(button.textContent).toBe("0.300,0.200");
});

const FromHarness = () => {
  const [point, setPoint] = useState({ x: 0, y: 0 });
  const { startDrag, ...handlers } = useBoxDrag({
    adjust: ({
      box: start,
      delta,
    }: BoxDragAdjustment<typeof point, "draw">) => ({
      x: start.x + delta.x,
      y: start.y + delta.y,
    }),
    box: point,
    onChange: setPoint,
  });
  return (
    <div data-testid="surface">
      <button
        {...handlers}
        onPointerDown={(event) => {
          const surface = event.currentTarget.parentElement;
          if (surface) {
            // Where the press landed, which no render has seen yet.
            startDrag(event, {
              from: { x: 0.5, y: 0.25 },
              mode: "draw",
              surface,
            });
          }
        }}
        type="button"
      >
        {`${point.x.toFixed(3)},${point.y.toFixed(3)}`}
      </button>
    </div>
  );
};

test("a drag can start from a box the caller names instead of the rendered one", () => {
  const view = render(<FromHarness />);
  const button = view.getByRole("button");
  Object.assign(button, { setPointerCapture: () => undefined });
  Object.assign(view.getByTestId("surface"), {
    getBoundingClientRect: () => new DOMRect(0, 0, 200, 100),
  });

  fireEvent.pointerDown(button, {
    button: 0,
    clientX: 0,
    clientY: 0,
    pointerId: 7,
  });
  fireEvent.pointerMove(button, { clientX: 20, clientY: 10, pointerId: 7 });

  expect(button.textContent).toBe("0.600,0.350");
});

test("a collapsed surface produces no displacement", () => {
  const { button, surface } = setup();
  Object.assign(surface, {
    getBoundingClientRect: () => new DOMRect(0, 0, 0, 0),
  });
  fireEvent.pointerDown(button, {
    button: 0,
    clientX: 0,
    clientY: 0,
    pointerId: 7,
  });
  fireEvent.pointerMove(button, { clientX: 20, clientY: 10, pointerId: 7 });
  expect(button.textContent).toBe("0.200,0.300");
});
