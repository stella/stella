import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

GlobalRegistrator.register();
const previousActEnvironment: unknown = Reflect.get(
  globalThis,
  "IS_REACT_ACT_ENVIRONMENT",
);
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { act, cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { useState } = await import("react");
const { INLINE_OVERFLOW_ITEM_ATTRIBUTE, INLINE_OVERFLOW_TRIGGER_ATTRIBUTE } =
  await import("../hooks/use-inline-overflow");
const { WorkspaceViewSwitcher } =
  await import("../../../workspace-ui/src/view-switcher");

// happy-dom lays nothing out. Each measured tab is 100px wide, the overflow
// trigger 24px, and the row the tabs share is `rowWidth` wide, so the
// policy has real numbers to split on.
const TAB_WIDTH = 100;
const TRIGGER_WIDTH = 24;
let rowWidth = 250;
/** Tabs a test draws at a width of their own, by name. */
const tabWidths = new Map<string, number>();

// The row the tabs share is the strip's first child, `rowWidth` wide.
const isRow = (target: Element) =>
  target.parentElement instanceof HTMLElement &&
  target.parentElement.dataset["slot"] === "workspace-view-switcher";

const originalRect = HTMLElement.prototype.getBoundingClientRect;
const rect = (width: number) => new DOMRect(0, 0, width, 32);
HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect(
  this: HTMLElement,
) {
  if (this.hasAttribute(INLINE_OVERFLOW_ITEM_ATTRIBUTE)) {
    return rect(tabWidths.get(this.textContent) ?? TAB_WIDTH);
  }
  if (this.hasAttribute(INLINE_OVERFLOW_TRIGGER_ATTRIBUTE)) {
    return rect(TRIGGER_WIDTH);
  }
  if (isRow(this)) {
    return rect(rowWidth);
  }
  return originalRect.call(this);
};

// Its observer reports `rowWidth` as the row's content box, the way a
// browser's would.
const observers = new Set<() => void>();
class ResizeObserverStub implements ResizeObserver {
  private readonly targets = new Set<Element>();
  private readonly notify: () => void;
  constructor(callback: ResizeObserverCallback) {
    this.notify = () =>
      callback(
        Array.from(this.targets, (target) => ({
          borderBoxSize: [],
          contentBoxSize: [],
          contentRect: rect(isRow(target) ? rowWidth : 0),
          devicePixelContentBoxSize: [],
          target,
        })),
        this,
      );
  }
  observe(target: Element) {
    this.targets.add(target);
    observers.add(this.notify);
    // A browser reports every observed element once after `observe`.
    queueMicrotask(this.notify);
  }
  unobserve() {}
  disconnect() {
    this.targets.clear();
    observers.delete(this.notify);
  }
}
const previousResizeObserver = globalThis.ResizeObserver;
globalThis.ResizeObserver = ResizeObserverStub;

afterEach(() => {
  cleanup();
  observers.clear();
  tabWidths.clear();
  rowWidth = 250;
});

afterAll(async () => {
  HTMLElement.prototype.getBoundingClientRect = originalRect;
  globalThis.ResizeObserver = previousResizeObserver;
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousActEnvironment);
  await unregisterDomEnvironment();
});

const VIEWS = [
  { id: "table", name: "All matters" },
  { id: "calendar", name: "Deadlines" },
  { id: "filesystem", name: "Lists" },
  { id: "correspondence", name: "Correspondence" },
];

const Harness = ({
  initialViewId = "table",
  views = VIEWS,
}: {
  initialViewId?: string;
  views?: readonly { id: string; name: string }[];
}) => {
  const [activeViewId, setActiveViewId] = useState(initialViewId);
  return (
    <WorkspaceViewSwitcher
      activeViewId={activeViewId}
      addControl={<button type="button">Add view</button>}
      ariaLabel="Saved views"
      direction="ltr"
      onViewChange={setActiveViewId}
      overflowLabel="Show more"
      renderIcon={() => null}
      reorder={null}
      views={views}
    />
  );
};

const tabNames = (container: HTMLElement) =>
  Array.from(
    container.querySelectorAll(
      '[role="tablist"][aria-label="Saved views"] [role="tab"]',
    ),
    (tab) => tab.textContent,
  );

describe("WorkspaceViewSwitcher overflow", () => {
  test("views with no room move into the overflow menu, and the chosen one shows", async () => {
    const mounted = render(<Harness />);

    // 250px holds two 100px tabs beside the 24px trigger, not three.
    await waitFor(() => {
      expect(tabNames(mounted.container)).toEqual(["All matters", "Deadlines"]);
    });
    const addView = mounted.getByRole("button", { name: "Add view" });
    expect(addView.parentElement?.className).not.toContain("border-s");

    const more = mounted.getByRole("button", { name: "Show more" });
    await act(async () => {
      fireEvent.click(more);
    });
    const items = await waitFor(() => {
      const found = mounted.getAllByRole("menuitem");
      expect(found.length).toBe(2);
      return found;
    });
    expect(items.map((item) => item.textContent)).toEqual([
      "Lists",
      "Correspondence",
    ]);

    await act(async () => {
      fireEvent.click(
        mounted.getByRole("menuitem", { name: "Correspondence" }),
      );
    });

    // The active view takes the last visible slot; the others keep their
    // order and the one it displaced joins the menu.
    await waitFor(() => {
      expect(tabNames(mounted.container)).toEqual([
        "All matters",
        "Correspondence",
      ]);
    });
    expect(
      mounted
        .getByRole("tab", { name: "Correspondence" })
        .getAttribute("aria-selected"),
    ).toBe("true");
  });

  test("every view is a tab again once the row has room", async () => {
    const mounted = render(<Harness />);
    await waitFor(() => {
      expect(tabNames(mounted.container)).toHaveLength(2);
    });

    rowWidth = 600;
    await act(async () => {
      for (const notify of observers) {
        notify();
      }
    });

    expect(tabNames(mounted.container)).toEqual(VIEWS.map(({ name }) => name));
    expect(mounted.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  test("a reordered strip recounts what fits, though its size stays the same", async () => {
    // Narrow, wide, narrow; the last is open. Swapping the first two keeps the
    // measuring row's size, which no observer reports, so only the order says
    // the old count no longer fits.
    rowWidth = 160;
    tabWidths.set("All matters", 50);
    tabWidths.set("Deadlines", 150);
    tabWidths.set("Lists", 50);
    const [table, calendar, filesystem] = VIEWS;
    if (!table || !calendar || !filesystem) {
      throw new Error("The fixture lists three views");
    }
    const mounted = render(
      <Harness
        initialViewId="filesystem"
        views={[table, calendar, filesystem]}
      />,
    );
    await waitFor(() => {
      expect(tabNames(mounted.container)).toEqual(["All matters", "Lists"]);
    });

    mounted.rerender(
      <Harness
        initialViewId="filesystem"
        views={[calendar, table, filesystem]}
      />,
    );

    // Deadlines (150) beside Lists (50) and the trigger is past 160px.
    await waitFor(() => {
      expect(tabNames(mounted.container)).toEqual(["Lists"]);
    });
  });
});
