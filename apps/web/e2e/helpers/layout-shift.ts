// The smoke project is node-only; the observer runs inside the browser.
/// <reference lib="dom" />
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

type LayoutShiftMeasurement = {
  supported: boolean;
  cls: number;
  values: number[];
};

declare global {
  var __routeLayoutShift: (() => LayoutShiftMeasurement) | undefined;
}

const MAX_ROUTE_CLS = 0.1;

export const observeLayoutShift = async (page: Page) => {
  await page.addInitScript(() => {
    const values: number[] = [];
    const collect = (entries: PerformanceEntry[]) => {
      for (const entry of entries) {
        if (
          "hadRecentInput" in entry &&
          entry.hadRecentInput === false &&
          "value" in entry &&
          typeof entry.value === "number"
        ) {
          values.push(entry.value);
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
