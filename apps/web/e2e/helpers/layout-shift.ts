// The smoke project is node-only; the observer runs inside the browser.
/// <reference lib="dom" />
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

type LayoutShiftMeasurement = {
  supported: boolean;
  cls: number;
  values: number[];
  shifts: {
    value: number;
    startTime: number;
    sources: {
      element: string | null;
      previousRect: { x: number; y: number; width: number; height: number };
      currentRect: { x: number; y: number; width: number; height: number };
    }[];
  }[];
};

type LayoutShiftEntry = PerformanceEntry & {
  hadRecentInput: boolean;
  value: number;
  sources: {
    node: Node | null;
    previousRect: DOMRectReadOnly;
    currentRect: DOMRectReadOnly;
  }[];
};

declare global {
  var __routeLayoutShift: (() => LayoutShiftMeasurement) | undefined;
}

const MAX_ROUTE_CLS = 0.1;

export const observeLayoutShift = async (page: Page) => {
  await page.addInitScript(() => {
    const values: number[] = [];
    const shifts: LayoutShiftMeasurement["shifts"] = [];
    const isLayoutShift = (
      entry: PerformanceEntry,
    ): entry is LayoutShiftEntry => entry.entryType === "layout-shift";
    const rectangle = ({ x, y, width, height }: DOMRectReadOnly) => ({
      x,
      y,
      width,
      height,
    });
    const collect = (entries: PerformanceEntry[]) => {
      for (const entry of entries) {
        if (isLayoutShift(entry) && !entry.hadRecentInput) {
          values.push(entry.value);
          shifts.push({
            value: entry.value,
            startTime: entry.startTime,
            sources: entry.sources.map(
              ({ node, previousRect, currentRect }) => ({
                element:
                  node instanceof Element
                    ? `${node.tagName.toLowerCase()}#${node.id}.${Array.from(node.classList).join(".")}`
                    : null,
                previousRect: rectangle(previousRect),
                currentRect: rectangle(currentRect),
              }),
            ),
          });
        }
      }
    };
    const supported =
      PerformanceObserver.supportedEntryTypes.includes("layout-shift");
    const observer = supported
      ? new PerformanceObserver((list) => collect(list.getEntries()))
      : null;
    observer?.observe({ type: "layout-shift", buffered: true });
    Object.defineProperty(globalThis, "__routeLayoutShift", {
      value: () => {
        if (observer !== null) {
          collect(observer.takeRecords());
        }
        return {
          supported,
          cls: values.reduce((sum, value) => sum + value, 0),
          values,
          shifts,
        };
      },
    });
  });
};

export const assertRouteLayoutShift = async (page: Page, route: string) => {
  const measurement = await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
    });
    if (
      !("__routeLayoutShift" in globalThis) ||
      typeof globalThis.__routeLayoutShift !== "function"
    ) {
      throw new Error("Route layout-shift observer was not installed");
    }
    return globalThis.__routeLayoutShift();
  });
  await test.info().attach("layout-shift", {
    body: JSON.stringify({ route, ...measurement }, null, 2),
    contentType: "application/json",
  });
  expect(
    measurement.supported,
    `${route}: layout-shift measurement must be supported`,
  ).toBe(true);
  expect(
    measurement.cls,
    `${route}: cumulative layout shift (entries: ${measurement.values.join(", ")})`,
  ).toBeLessThanOrEqual(MAX_ROUTE_CLS);
};
