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
  static notify() {
    const stub: ResizeObserver = {
      disconnect: () => undefined,
      observe: () => undefined,
      unobserve: () => undefined,
    };
    TestResizeObserver.callback?.([], stub);
  }
}

const divOf = (node: Element | null | undefined): HTMLDivElement => {
  if (!(node instanceof HTMLDivElement)) {
    throw new TypeError("Expected the scroller element");
  }
  return node;
};
globalThis.ResizeObserver = TestResizeObserver;

const { act, cleanup, fireEvent, render } =
  await import("@testing-library/react");
const { HorizontalScroller, scrollState, wheelDeltaPixels } =
  await import("./horizontal-scroller");

afterEach(cleanup);
afterAll(async () => GlobalRegistrator.unregister());

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
  const viewport = divOf(view.getByText("Item").parentElement?.parentElement);
  Object.defineProperties(viewport, {
    clientWidth: { value: 100 },
    scrollWidth: { value: 300 },
    scrollBy: { value: scrollBy },
  });
  act(() => TestResizeObserver.notify());
  expect(view.getByLabelText("Previous").getAttribute("aria-disabled")).toBe(
    "true",
  );
  expect(view.getByLabelText("Previous").tabIndex).toBe(-1);
  expect(view.getByLabelText("Next").tabIndex).toBe(0);
  fireEvent.click(view.getByLabelText("Next"));
  expect(scrollBy).toHaveBeenCalledWith({ behavior: "smooth", left: 80 });
  Object.defineProperty(viewport, "scrollLeft", {
    configurable: true,
    value: 100,
  });
  fireEvent.scroll(viewport);
  expect(view.getByLabelText("Previous").getAttribute("aria-disabled")).toBe(
    "false",
  );
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
  const viewport = divOf(item.parentElement?.parentElement);
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
  const viewport = getByText("Item").parentElement?.parentElement;
  expect(viewport?.className).toContain("scrollbar-subtle");
  expect(viewport?.className).not.toContain("scrollbar-none");
});

test("scrolls a right-to-left row towards its inline end on a downward wheel", () => {
  const scrollBy = mock(() => undefined);
  const view = render(
    <HorizontalScroller previousLabel="Previous" nextLabel="Next">
      <button type="button">Item</button>
    </HorizontalScroller>,
  );
  const viewport = divOf(view.getByText("Item").parentElement?.parentElement);
  viewport.style.direction = "rtl";
  Object.defineProperties(viewport, {
    clientWidth: { value: 100 },
    scrollWidth: { value: 300 },
    scrollBy: { value: scrollBy },
  });
  fireEvent.wheel(viewport, { deltaX: 0, deltaY: 24 });
  expect(scrollBy).toHaveBeenCalledWith({ left: -24 });
});

test("updates its controls when content changes at a fixed viewport size", () => {
  const view = render(
    <HorizontalScroller previousLabel="Previous" nextLabel="Next">
      <button type="button">Item 0</button>
    </HorizontalScroller>,
  );
  const content = divOf(view.getByText("Item 0").parentElement);
  const viewport = divOf(content.parentElement);
  expect(TestResizeObserver.observed.has(content)).toBe(true);
  let scrollWidth = 100;
  Object.defineProperties(viewport, {
    clientWidth: { value: 100 },
    scrollWidth: { get: () => scrollWidth },
  });
  const contentResized = () => act(() => TestResizeObserver.notify());
  contentResized();
  expect(view.queryByLabelText("Next")).toBeNull();

  scrollWidth = 300;
  contentResized();
  expect(view.getByLabelText("Next")).toBeTruthy();

  scrollWidth = 100;
  contentResized();
  expect(view.queryByLabelText("Next")).toBeNull();
});

test("leaves ctrl+wheel to the page for pinch zoom", () => {
  const scrollBy = mock(() => undefined);
  const view = render(
    <HorizontalScroller previousLabel="Previous" nextLabel="Next">
      <button type="button">Item</button>
    </HorizontalScroller>,
  );
  const viewport = divOf(view.getByText("Item").parentElement?.parentElement);
  Object.defineProperties(viewport, {
    clientWidth: { value: 100 },
    scrollWidth: { value: 300 },
    scrollBy: { value: scrollBy },
  });
  const pinch = new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    deltaX: 0,
    deltaY: 24,
  });
  // The DOM test environment drops modifier keys from wheel event init.
  Object.defineProperty(pinch, "ctrlKey", { value: true });
  const allowed = viewport.dispatchEvent(pinch);
  expect(allowed).toBe(true);
  expect(scrollBy).not.toHaveBeenCalled();
});

test("converts line and page wheel deltas to pixels", () => {
  const node = { clientWidth: 200 };
  expect(wheelDeltaPixels({ deltaMode: 0, deltaY: 24 }, node)).toBe(24);
  expect(wheelDeltaPixels({ deltaMode: 1, deltaY: 3 }, node)).toBe(48);
  expect(wheelDeltaPixels({ deltaMode: 2, deltaY: 1 }, node)).toBe(200);
});

test("hands the wheel back to the page at the edge it would move past", () => {
  const scrollBy = mock(() => undefined);
  const view = render(
    <HorizontalScroller previousLabel="Previous" nextLabel="Next">
      <button type="button">Item</button>
    </HorizontalScroller>,
  );
  const viewport = divOf(view.getByText("Item").parentElement?.parentElement);
  let scrollLeft = 0;
  Object.defineProperties(viewport, {
    clientWidth: { value: 100 },
    scrollWidth: { value: 300 },
    scrollLeft: { get: () => scrollLeft },
    scrollBy: { value: scrollBy },
  });
  const wheel = (deltaY: number) =>
    fireEvent.wheel(viewport, { cancelable: true, deltaX: 0, deltaY });

  expect(wheel(-24)).toBe(true);
  scrollLeft = 200;
  expect(wheel(24)).toBe(true);
  expect(scrollBy).not.toHaveBeenCalled();
  expect(wheel(-24)).toBe(false);

  viewport.style.direction = "rtl";
  scrollLeft = 0;
  expect(wheel(-24)).toBe(true);
  scrollLeft = -200;
  expect(wheel(24)).toBe(true);
  expect(wheel(-24)).toBe(false);
});

test("lets keyboard users reach and operate an overflowing row of static content", () => {
  const scrollBy = mock(() => undefined);
  const view = render(
    <HorizontalScroller previousLabel="Previous" nextLabel="Next">
      <span>Static item</span>
    </HorizontalScroller>,
  );
  const viewport = divOf(
    view.getByText("Static item").parentElement?.parentElement,
  );
  Object.defineProperties(viewport, {
    clientWidth: { value: 100 },
    scrollWidth: { value: 300 },
    scrollBy: { value: scrollBy },
  });
  act(() => TestResizeObserver.notify());
  const next = view.getByLabelText("Next");
  expect(next.tabIndex).toBe(0);
  next.focus();
  expect(document.activeElement).toBe(next);
  fireEvent.click(next);
  expect(scrollBy).toHaveBeenCalledWith({ behavior: "smooth", left: 80 });
});

test("keeps focus on a control that scrolled the row to its edge", () => {
  const scrollBy = mock(() => undefined);
  const view = render(
    <HorizontalScroller previousLabel="Previous" nextLabel="Next">
      <span>Static item</span>
    </HorizontalScroller>,
  );
  const viewport = divOf(
    view.getByText("Static item").parentElement?.parentElement,
  );
  let scrollLeft = 0;
  Object.defineProperties(viewport, {
    clientWidth: { value: 100 },
    scrollWidth: { value: 300 },
    scrollLeft: { get: () => scrollLeft },
    scrollBy: { value: scrollBy },
  });
  act(() => TestResizeObserver.notify());
  const next = view.getByLabelText("Next");
  next.focus();
  scrollLeft = 200;
  fireEvent.scroll(viewport);

  expect(document.activeElement).toBe(next);
  expect(next.getAttribute("aria-disabled")).toBe("true");
  expect(next.tabIndex).toBe(-1);
  expect(next.className).toContain("focus-visible:opacity-100");
  expect(view.getByLabelText("Previous").tabIndex).toBe(0);
  fireEvent.click(next);
  expect(scrollBy).not.toHaveBeenCalled();
});
