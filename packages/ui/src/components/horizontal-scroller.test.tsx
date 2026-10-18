import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, mock, test } from "bun:test";

GlobalRegistrator.register();

class TestResizeObserver {
  static callback: ResizeObserverCallback | undefined;
  static observed = new Set<Element>();
  constructor(callback: ResizeObserverCallback) {
    TestResizeObserver.callback = callback;
  }
  disconnect() {
    TestResizeObserver.observed.clear();
  }
  observe(target: Element) {
    TestResizeObserver.observed.add(target);
  }
  unobserve(target: Element) {
    TestResizeObserver.observed.delete(target);
  }
}
globalThis.ResizeObserver = TestResizeObserver;

const { act, cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { HorizontalScroller, scrollState, wheelDeltaPixels } =
  await import("./horizontal-scroller");

afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

test("reports logical start, middle, end, no overflow, and RTL", () => {
  expect(scrollState(0, 300, 100, "ltr")).toEqual({
    canScrollStart: false,
    canScrollEnd: true,
  });
  expect(scrollState(100, 300, 100, "ltr")).toEqual({
    canScrollStart: true,
    canScrollEnd: true,
  });
  expect(scrollState(200, 300, 100, "ltr")).toEqual({
    canScrollStart: true,
    canScrollEnd: false,
  });
  expect(scrollState(0, 100, 100, "ltr")).toEqual({
    canScrollStart: false,
    canScrollEnd: false,
  });
  expect(scrollState(-200, 300, 100, "rtl")).toEqual({
    canScrollStart: true,
    canScrollEnd: false,
  });
});

test("shows directional controls and scrolls forward", () => {
  const scrollBy = mock(() => undefined);
  const view = render(
    <HorizontalScroller previousLabel="Previous" nextLabel="Next">
      <button type="button">Item</button>
    </HorizontalScroller>,
  );
  const viewport = view.getByText("Item").parentElement as HTMLDivElement;
  Object.defineProperties(viewport, {
    clientWidth: { value: 100 },
    scrollWidth: { value: 300 },
    scrollBy: { value: scrollBy },
  });
  act(() =>
    TestResizeObserver.callback?.([], new TestResizeObserver(() => undefined)),
  );
  expect(view.queryByLabelText("Previous")).toBeNull();
  fireEvent.click(view.getByLabelText("Next"));
  expect(scrollBy).toHaveBeenCalledWith({ behavior: "smooth", left: 80 });
  Object.defineProperty(viewport, "scrollLeft", {
    configurable: true,
    value: 100,
  });
  fireEvent.scroll(viewport);
  expect(view.getByLabelText("Previous")).toBeTruthy();
});

test("converts vertical wheel input and reveals focused content", () => {
  const scrollBy = mock(() => undefined);
  const scrollIntoView = mock(() => undefined);
  const view = render(
    <HorizontalScroller previousLabel="Previous" nextLabel="Next">
      <button type="button">Item</button>
    </HorizontalScroller>,
  );
  const item = view.getByText("Item");
  const viewport = item.parentElement as HTMLDivElement;
  Object.defineProperties(viewport, {
    clientWidth: { value: 100 },
    scrollWidth: { value: 300 },
    scrollBy: { value: scrollBy },
  });
  item.scrollIntoView = scrollIntoView;
  fireEvent.wheel(viewport, { deltaX: 0, deltaY: 24 });
  expect(scrollBy).toHaveBeenCalledWith({ left: 24 });
  fireEvent.focus(item);
  expect(scrollIntoView).toHaveBeenCalledWith({
    block: "nearest",
    inline: "nearest",
  });
});

test("keeps a visible subtle scrollbar", () => {
  const { getByText } = render(
    <HorizontalScroller previousLabel="Previous" nextLabel="Next">
      <span>Item</span>
    </HorizontalScroller>,
  );
  expect(getByText("Item").parentElement?.className).toContain(
    "scrollbar-subtle",
  );
  expect(getByText("Item").parentElement?.className).not.toContain(
    "scrollbar-none",
  );
});

test("scrolls a right-to-left row towards its inline end on a downward wheel", () => {
  const scrollBy = mock(() => undefined);
  const view = render(
    <HorizontalScroller previousLabel="Previous" nextLabel="Next">
      <button type="button">Item</button>
    </HorizontalScroller>,
  );
  const viewport = view.getByText("Item").parentElement as HTMLDivElement;
  viewport.style.direction = "rtl";
  Object.defineProperties(viewport, {
    clientWidth: { value: 100 },
    scrollWidth: { value: 300 },
    scrollBy: { value: scrollBy },
  });
  fireEvent.wheel(viewport, { deltaX: 0, deltaY: 24 });
  expect(scrollBy).toHaveBeenCalledWith({ left: -24 });
});

test("updates its controls when content changes at a fixed viewport size", async () => {
  const items = (count: number) =>
    Array.from({ length: count }, (_, index) => (
      <button key={index} type="button">
        Item {index}
      </button>
    ));
  const view = render(
    <HorizontalScroller previousLabel="Previous" nextLabel="Next">
      {items(1)}
    </HorizontalScroller>,
  );
  const viewport = view.getByText("Item 0").parentElement as HTMLDivElement;
  let scrollWidth = 100;
  Object.defineProperties(viewport, {
    clientWidth: { value: 100 },
    scrollWidth: { get: () => scrollWidth },
  });
  act(() =>
    TestResizeObserver.callback?.([], new TestResizeObserver(() => undefined)),
  );
  expect(view.queryByLabelText("Next")).toBeNull();

  scrollWidth = 300;
  view.rerender(
    <HorizontalScroller previousLabel="Previous" nextLabel="Next">
      {items(4)}
    </HorizontalScroller>,
  );
  await waitFor(() => expect(view.getByLabelText("Next")).toBeTruthy());
  expect(TestResizeObserver.observed.has(view.getByText("Item 3"))).toBe(true);

  scrollWidth = 100;
  view.rerender(
    <HorizontalScroller previousLabel="Previous" nextLabel="Next">
      {items(1)}
    </HorizontalScroller>,
  );
  await waitFor(() => expect(view.queryByLabelText("Next")).toBeNull());
});

test("leaves ctrl+wheel to the page for pinch zoom", () => {
  const scrollBy = mock(() => undefined);
  const view = render(
    <HorizontalScroller previousLabel="Previous" nextLabel="Next">
      <button type="button">Item</button>
    </HorizontalScroller>,
  );
  const viewport = view.getByText("Item").parentElement as HTMLDivElement;
  Object.defineProperties(viewport, {
    clientWidth: { value: 100 },
    scrollWidth: { value: 300 },
    scrollBy: { value: scrollBy },
  });
  const allowed = fireEvent.wheel(viewport, {
    cancelable: true,
    ctrlKey: true,
    deltaX: 0,
    deltaY: 24,
  });
  expect(allowed).toBe(true);
  expect(scrollBy).not.toHaveBeenCalled();
});

test("converts line and page wheel deltas to pixels", () => {
  const node = { clientWidth: 200 };
  expect(wheelDeltaPixels({ deltaMode: 0, deltaY: 24 }, node)).toBe(24);
  expect(wheelDeltaPixels({ deltaMode: 1, deltaY: 3 }, node)).toBe(48);
  expect(wheelDeltaPixels({ deltaMode: 2, deltaY: 1 }, node)).toBe(200);
});
