import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

GlobalRegistrator.register();
const previousActEnvironment: unknown = Reflect.get(
  globalThis,
  "IS_REACT_ACT_ENVIRONMENT",
);
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { act, cleanup, render } = await import("@testing-library/react");
const { INLINE_OVERFLOW_ITEM_ATTRIBUTE, INLINE_OVERFLOW_TRIGGER_ATTRIBUTE } =
  await import("../hooks/use-inline-overflow");
const { InspectorFacetBar } = await import("./facet-bar");

// happy-dom lays nothing out. Every chip is 100px wide, the overflow trigger
// 24px, and the row inside the bar `barWidth` wide, so the policy has real
// numbers to split.
const CHIP_WIDTH = 100;
const TRIGGER_WIDTH = 24;
let barWidth = 250;

const originalRect = HTMLElement.prototype.getBoundingClientRect;
const rect = (width: number) => new DOMRect(0, 0, width, 32);
HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect(
  this: HTMLElement,
) {
  if (this.hasAttribute(INLINE_OVERFLOW_ITEM_ATTRIBUTE)) {
    return rect(CHIP_WIDTH);
  }
  if (this.hasAttribute(INLINE_OVERFLOW_TRIGGER_ATTRIBUTE)) {
    return rect(TRIGGER_WIDTH);
  }
  if (this.dataset["slot"] === "inspector-facet-row") {
    return rect(barWidth);
  }
  return originalRect.call(this);
};

// An observer that reports only when a test says so: a browser reports at
// its next rendering update, which a busy or throttled page can hold back
// while scripts already read the committed row.
const pendingReports = new Set<() => void>();
class HeldResizeObserver implements ResizeObserver {
  private readonly report: () => void;
  constructor(callback: ResizeObserverCallback) {
    this.report = () => callback([], this);
  }
  observe() {
    pendingReports.add(this.report);
  }
  unobserve() {}
  disconnect() {
    pendingReports.delete(this.report);
  }
}
const previousResizeObserver = globalThis.ResizeObserver;
globalThis.ResizeObserver = HeldResizeObserver;

afterEach(() => {
  cleanup();
  pendingReports.clear();
  barWidth = 250;
});

afterAll(async () => {
  HTMLElement.prototype.getBoundingClientRect = originalRect;
  globalThis.ResizeObserver = previousResizeObserver;
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousActEnvironment);
  await unregisterDomEnvironment();
});

type Facet = "metadata" | "versions" | "review" | "anonymization";
const FACETS: readonly Facet[] = [
  "metadata",
  "versions",
  "review",
  "anonymization",
];
const LABELS: Record<Facet, string> = {
  metadata: "Metadata",
  versions: "Version history",
  review: "Review document",
  anonymization: "Anonymization",
};

const renderBar = () =>
  render(
    <InspectorFacetBar
      facet="metadata"
      facets={FACETS}
      labels={LABELS}
      onChange={() => undefined}
      overflowMenuLabel="Show more"
    />,
  );

const shownChips = (container: HTMLElement) =>
  Array.from(
    container.querySelectorAll<HTMLElement>("[data-facet-value]"),
    (chip) => chip.dataset["facetValue"],
  );

const overflowTrigger = (container: HTMLElement) =>
  container.querySelector("[data-slot=inspector-facet-overflow-trigger]");

describe("InspectorFacetBar overflow", () => {
  test("the first committed row already fits, before any observer report", () => {
    const { container } = renderBar();

    // 250px holds two 100px chips beside the 24px trigger, not three. No
    // observer has reported, so the count came from the commit itself.
    expect(pendingReports.size).toBeGreaterThan(0);
    expect(shownChips(container)).toEqual(["metadata", "versions"]);
    expect(overflowTrigger(container)).not.toBeNull();
  });

  test("a later resize the observer reports recounts the row", async () => {
    const { container } = renderBar();
    expect(shownChips(container)).toEqual(["metadata", "versions"]);

    barWidth = 600;
    await act(async () => {
      for (const report of pendingReports) {
        report();
      }
    });

    expect(shownChips(container)).toEqual([...FACETS]);
    expect(overflowTrigger(container)).toBeNull();
  });
});
