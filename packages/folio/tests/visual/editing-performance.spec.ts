import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import type { Layout } from "../../src/core/layout-engine/types";
import type { LayoutInstrumentation } from "../../src/paged-editor/layoutInstrumentation";

const PARAGRAPH_COUNT = 1500;
const TYPING_TEXT = "abc";
const BURST_MEASURE_BLOCK_BUDGET = 50;

type LayoutMeasurementStats = {
  layoutCompletions: number;
  measureBlockCalls: number;
};

type LayoutSnapshot = {
  pages: {
    fragments: {
      fromLine?: number;
      fromRow?: number;
      height?: number;
      kind: string;
      pmEnd?: number;
      pmStart?: number;
      toLine?: number;
      toRow?: number;
      width?: number;
      x: number;
      y: number;
    }[];
    number: number;
  }[];
};

declare global {
  var __folioPlayground:
    | {
        getEditorRef: () => {
          getEditorRef: () => {
            getLayout: () => Layout | null;
            relayout: () => void;
          } | null;
        } | null;
      }
    | undefined;
  var __folioLayoutInstrumentation: LayoutInstrumentation | undefined;
  var __folioLayoutMeasurementStats: LayoutMeasurementStats | undefined;
}

test("typing in a large document does not remeasure every block during the burst", async ({
  page,
}) => {
  await page.addInitScript(() => {
    globalThis.__folioLayoutMeasurementStats = {
      layoutCompletions: 0,
      measureBlockCalls: 0,
    };
    globalThis.__folioLayoutInstrumentation = {
      onLayoutComplete() {
        const stats = globalThis.__folioLayoutMeasurementStats;
        if (stats) {
          stats.layoutCompletions += 1;
        }
      },
      onMeasureBlock() {
        const stats = globalThis.__folioLayoutMeasurementStats;
        if (stats) {
          stats.measureBlockCalls += 1;
        }
      },
    };
  });

  await page.goto(`/?paragraphs=${PARAGRAPH_COUNT}`);
  await page.waitForSelector('[data-testid="folio-editor"]');
  await page.waitForFunction(
    () => document.querySelectorAll(".layout-page").length >= 20,
  );
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await page.waitForTimeout(250);

  await page.evaluate(() => {
    const stats = globalThis.__folioLayoutMeasurementStats;
    if (stats) {
      stats.measureBlockCalls = 0;
    }
  });

  const startedAt = performance.now();
  await page
    .locator(".layout-page")
    .first()
    .click({ position: { x: 120, y: 120 } });
  await page.keyboard.type(TYPING_TEXT, { delay: 20 });
  await page.waitForTimeout(75);
  const elapsedMs = performance.now() - startedAt;

  const stats = await page.evaluate(
    () => globalThis.__folioLayoutMeasurementStats,
  );

  console.info("folio typing burst layout diagnostic", {
    elapsedMs: Number(elapsedMs.toFixed(3)),
    measureBlockCalls: stats?.measureBlockCalls,
    paragraphCount: PARAGRAPH_COUNT,
    typedCharacters: TYPING_TEXT.length,
  });

  expect(stats?.measureBlockCalls).toBeLessThanOrEqual(
    BURST_MEASURE_BLOCK_BUDGET,
  );
});

test("idle layout after editing matches a fresh full relayout", async ({
  page,
}) => {
  await page.addInitScript(() => {
    globalThis.__folioLayoutMeasurementStats = {
      layoutCompletions: 0,
      measureBlockCalls: 0,
    };
    globalThis.__folioLayoutInstrumentation = {
      onLayoutComplete() {
        const stats = globalThis.__folioLayoutMeasurementStats;
        if (stats) {
          stats.layoutCompletions += 1;
        }
      },
      onMeasureBlock() {
        const stats = globalThis.__folioLayoutMeasurementStats;
        if (stats) {
          stats.measureBlockCalls += 1;
        }
      },
    };
  });

  await page.goto(`/?paragraphs=${PARAGRAPH_COUNT}`);
  await page.waitForSelector('[data-testid="folio-editor"]');
  await page.waitForFunction(
    () => document.querySelectorAll(".layout-page").length >= 20,
  );
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await page.waitForTimeout(250);

  await page
    .locator(".layout-page")
    .first()
    .click({ position: { x: 120, y: 120 } });
  await page.keyboard.type(TYPING_TEXT, { delay: 20 });
  await page.waitForTimeout(300);

  const idleSnapshot = await readLayoutSnapshot(page);
  const layoutCompletionsBeforeRelayout = await page.evaluate(
    () => globalThis.__folioLayoutMeasurementStats?.layoutCompletions ?? 0,
  );

  await page.evaluate(() => {
    globalThis.__folioPlayground?.getEditorRef()?.getEditorRef()?.relayout();
  });
  await page.waitForFunction(
    (previousCount) =>
      (globalThis.__folioLayoutMeasurementStats?.layoutCompletions ?? 0) >
      previousCount,
    layoutCompletionsBeforeRelayout,
  );

  const fullRelayoutSnapshot = await readLayoutSnapshot(page);

  expect(idleSnapshot).toEqual(fullRelayoutSnapshot);
});

async function readLayoutSnapshot(browserPage: Page) {
  return browserPage.evaluate((): LayoutSnapshot => {
    const layout = globalThis.__folioPlayground
      ?.getEditorRef()
      ?.getEditorRef()
      ?.getLayout();

    if (!layout) {
      throw new Error("Expected a PagedEditor layout snapshot");
    }

    const round = (value: number | undefined) =>
      value === undefined ? undefined : Number(value.toFixed(3));

    return {
      pages: layout.pages.map((layoutPage) => ({
        fragments: layoutPage.fragments.map((fragment) => ({
          fromLine: "fromLine" in fragment ? fragment.fromLine : undefined,
          fromRow: "fromRow" in fragment ? fragment.fromRow : undefined,
          height: round(fragment.height),
          kind: fragment.kind,
          pmEnd: fragment.pmEnd,
          pmStart: fragment.pmStart,
          toLine: "toLine" in fragment ? fragment.toLine : undefined,
          toRow: "toRow" in fragment ? fragment.toRow : undefined,
          width: round(fragment.width),
          x: round(fragment.x) ?? 0,
          y: round(fragment.y) ?? 0,
        })),
        number: layoutPage.number,
      })),
    };
  });
}
