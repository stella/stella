import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, mock, test } from "bun:test";

GlobalRegistrator.register();

class TestResizeObserver {
  static callback: ResizeObserverCallback | undefined;
  constructor(callback: ResizeObserverCallback) {
    TestResizeObserver.callback = callback;
  }
  disconnect() {}
  observe() {}
  unobserve() {}
}
globalThis.ResizeObserver = TestResizeObserver;

const { act, cleanup, fireEvent, render } =
  await import("@testing-library/react");
const { HorizontalScroller, scrollState } =
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
