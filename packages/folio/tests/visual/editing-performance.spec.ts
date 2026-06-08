import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import type {
  HiddenEditorStateReason,
  LayoutInstrumentation,
} from "../../src/core/layout-engine/layoutInstrumentation";
import type { Layout } from "../../src/core/layout-engine/types";

const PARAGRAPH_COUNT = 1500;
const TYPING_TEXT = "abc";
const INITIAL_LOAD_MEASURE_BLOCK_BUDGET = PARAGRAPH_COUNT + 10;
const DEMO_INITIAL_MEASURE_BLOCK_BUDGET = 60;
const INITIAL_RENDERED_PAGE_BUDGET = 4;
const BURST_LAYOUT_COMPLETION_BUDGET = 2;
const BURST_MEASURE_BLOCK_BUDGET = 50;
const IDLE_MEASURE_BLOCK_BUDGET = 50;

type LayoutMeasurementStats = {
  hiddenStateCreations: Record<HiddenEditorStateReason, number>;
  hiddenStateReasons: string[];
  layoutCompletions: number;
  layoutReasons: string[];
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
  await installLayoutMeasurement(page);

  await page.goto(`/?paragraphs=${PARAGRAPH_COUNT}`);
  await page.waitForSelector('[data-testid="folio-editor"]');
  await page.waitForFunction(
    () => document.querySelectorAll(".layout-page").length >= 20,
  );
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await page.waitForTimeout(650);

  await expect(
    page.locator(".paged-editor__hidden-pm .ProseMirror"),
  ).toHaveCount(0);

  const initialStats = await page.evaluate(
    () => globalThis.__folioLayoutMeasurementStats,
  );
  console.info("folio initial layout diagnostic", {
    hiddenStateCreations: initialStats?.hiddenStateCreations,
    hiddenStateReasons: initialStats?.hiddenStateReasons,
    initialMeasureBlockCalls: initialStats?.measureBlockCalls,
    initialReasons: initialStats?.layoutReasons,
    paragraphCount: PARAGRAPH_COUNT,
  });
  expect(initialStats?.measureBlockCalls).toBeLessThanOrEqual(
    INITIAL_LOAD_MEASURE_BLOCK_BUDGET,
  );
  expect(totalHiddenStateCreations(initialStats)).toBe(1);

  await page.evaluate(() => {
    const stats = globalThis.__folioLayoutMeasurementStats;
    if (stats) {
      stats.hiddenStateCreations = { "external-document": 0, mount: 0 };
      stats.hiddenStateReasons = [];
      stats.layoutCompletions = 0;
      stats.layoutReasons = [];
      stats.measureBlockCalls = 0;
    }
  });

  const startedAt = performance.now();
  const downstreamPmStartBefore = await readFirstPmStartOnRenderedPage(page, 1);
  await page
    .locator(".layout-page")
    .first()
    .click({ position: { x: 120, y: 120 } });
  await page.keyboard.type(TYPING_TEXT, { delay: 20 });
  await page.waitForTimeout(75);
  const elapsedMs = performance.now() - startedAt;

  const hiddenHost = await readHiddenEditorHostInfo(page);
  expect(hiddenHost.wrapperClass).toContain("paged-editor__hidden-pm-wrapper");
  expect(hiddenHost.wrapperHeight).toBe("1px");
  expect(hiddenHost.wrapperOverflow).toBe("hidden");
  expect(hiddenHost.wrapperWidth).toBe("1px");
  expect(hiddenHost.wrapperContain).toContain("layout");
  expect(hiddenHost.wrapperContain).toContain("paint");
  expect(hiddenHost.hostPosition).toBe("absolute");
  expect(hiddenHost.hostAriaHidden).toBeNull();
  expect(hiddenHost.pmRootAriaHidden).toBeNull();
  expect(hiddenHost.pmRootAriaReadonly).toBe("false");
  expect(hiddenHost.pmRootAutocapitalize).toBe("off");
  expect(hiddenHost.pmRootAutocorrect).toBe("off");
  expect(hiddenHost.pmRootRole).toBe("textbox");
  expect(hiddenHost.pmRootSpellcheck).toBe("false");
  expect(hiddenHost.pmRootTranslate).toBe("no");

  const stats = await page.evaluate(
    () => globalThis.__folioLayoutMeasurementStats,
  );
  const downstreamPmStartAfter = await readFirstPmStartOnRenderedPage(page, 1);

  console.info("folio typing burst layout diagnostic", {
    downstreamPmShift: downstreamPmStartAfter - downstreamPmStartBefore,
    elapsedMs: Number(elapsedMs.toFixed(3)),
    hiddenStateCreations: initialStats?.hiddenStateCreations,
    hiddenStateReasons: initialStats?.hiddenStateReasons,
    initialMeasureBlockCalls: initialStats?.measureBlockCalls,
    initialReasons: initialStats?.layoutReasons,
    layoutCompletions: stats?.layoutCompletions,
    layoutReasons: stats?.layoutReasons,
    measureBlockCalls: stats?.measureBlockCalls,
    paragraphCount: PARAGRAPH_COUNT,
    typedCharacters: TYPING_TEXT.length,
  });

  expect(stats?.layoutCompletions).toBeGreaterThan(0);
  expect(stats?.layoutCompletions).toBeLessThanOrEqual(
    BURST_LAYOUT_COMPLETION_BUDGET,
  );
  expect(stats?.measureBlockCalls).toBeLessThanOrEqual(
    BURST_MEASURE_BLOCK_BUDGET,
  );
  expect(downstreamPmStartAfter).toBe(
    downstreamPmStartBefore + TYPING_TEXT.length,
  );
});

test("fixture initial load does not perform duplicate font-ready relayout", async ({
  page,
}) => {
  await installLayoutMeasurement(page);

  await page.goto("/?file=docx-editor-demo.docx");
  await page.waitForSelector('[data-testid="folio-editor"]');
  await page.waitForFunction(
    () => document.querySelectorAll(".layout-page").length >= 3,
  );
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await page.waitForTimeout(300);

  const stats = await page.evaluate(
    () => globalThis.__folioLayoutMeasurementStats,
  );
  const fontReadyLayouts =
    stats?.layoutReasons.filter((reason) => reason === "font-ready") ?? [];
  console.info("folio fixture initial layout diagnostic", {
    layoutCompletions: stats?.layoutCompletions,
    layoutReasons: stats?.layoutReasons,
    measureBlockCalls: stats?.measureBlockCalls,
  });

  expect(stats?.layoutCompletions).toBe(1);
  expect(fontReadyLayouts).toHaveLength(0);
  expect(stats?.measureBlockCalls).toBeLessThanOrEqual(
    DEMO_INITIAL_MEASURE_BLOCK_BUDGET,
  );
});

test("incremental layout after editing stays stable and matches a fresh full relayout", async ({
  page,
}) => {
  await installLayoutMeasurement(page);

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
      stats.hiddenStateCreations = { "external-document": 0, mount: 0 };
      stats.hiddenStateReasons = [];
      stats.layoutCompletions = 0;
      stats.layoutReasons = [];
      stats.measureBlockCalls = 0;
    }
  });

  await page
    .locator(".layout-page")
    .first()
    .click({ position: { x: 120, y: 120 } });
  await page.keyboard.type(TYPING_TEXT, { delay: 20 });
  await page.waitForTimeout(300);

  const idleStats = await page.evaluate(
    () => globalThis.__folioLayoutMeasurementStats,
  );
  expect(idleStats?.measureBlockCalls).toBeLessThanOrEqual(
    IDLE_MEASURE_BLOCK_BUDGET,
  );

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

test("virtualized long documents render later pages on scroll", async ({
  page,
}) => {
  await page.goto(`/?paragraphs=${PARAGRAPH_COUNT}`);
  await page.waitForSelector('[data-testid="folio-editor"]');
  await page.waitForFunction(
    () => document.querySelectorAll(".layout-page").length >= 20,
  );
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await page.waitForTimeout(250);

  const initialRenderedPages = await page
    .locator(".layout-page-content")
    .count();
  expect(initialRenderedPages).toBeLessThanOrEqual(
    INITIAL_RENDERED_PAGE_BUDGET,
  );

  const targetPage = page.locator('.layout-page[data-page-index="20"]');
  await targetPage.scrollIntoViewIfNeeded();
  await expect(targetPage.locator(".layout-page-content")).toHaveCount(1);
});

async function installLayoutMeasurement(browserPage: Page): Promise<void> {
  await browserPage.addInitScript(() => {
    globalThis.__folioLayoutMeasurementStats = {
      hiddenStateCreations: { "external-document": 0, mount: 0 },
      hiddenStateReasons: [],
      layoutCompletions: 0,
      layoutReasons: [],
      measureBlockCalls: 0,
    };
    globalThis.__folioLayoutInstrumentation = {
      onHiddenEditorStateCreate(event) {
        const stats = globalThis.__folioLayoutMeasurementStats;
        if (stats) {
          stats.hiddenStateCreations[event.reason] += 1;
          stats.hiddenStateReasons.push(event.reason);
        }
      },
      onLayoutComplete(event) {
        const stats = globalThis.__folioLayoutMeasurementStats;
        if (stats) {
          stats.layoutCompletions += 1;
          stats.layoutReasons.push(event.reason);
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
}

function totalHiddenStateCreations(
  stats: LayoutMeasurementStats | undefined,
): number {
  if (!stats) {
    return 0;
  }
  return (
    stats.hiddenStateCreations.mount +
    stats.hiddenStateCreations["external-document"]
  );
}

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

async function readFirstPmStartOnRenderedPage(
  browserPage: Page,
  pageIndex: number,
): Promise<number> {
  const value = await browserPage
    .locator(`.layout-page[data-page-index="${pageIndex}"] [data-pm-start]`)
    .first()
    .getAttribute("data-pm-start");

  if (value === null) {
    throw new Error(`Expected page ${pageIndex} to expose PM position data`);
  }

  return Number(value);
}

async function readHiddenEditorHostInfo(browserPage: Page) {
  return browserPage.evaluate(() => {
    const host = document.querySelector<HTMLElement>(
      ".paged-editor__hidden-pm",
    );
    const wrapper = host?.parentElement;
    const pmRoot = host?.querySelector<HTMLElement>(".ProseMirror");
    if (!host || !wrapper || !pmRoot) {
      throw new Error("Expected hidden ProseMirror host to be mounted");
    }

    const wrapperStyle = getComputedStyle(wrapper);
    const hostStyle = getComputedStyle(host);
    return {
      hostAriaHidden: host.getAttribute("aria-hidden"),
      hostPosition: hostStyle.position,
      pmRootAriaHidden: pmRoot.getAttribute("aria-hidden"),
      pmRootAriaReadonly: pmRoot.getAttribute("aria-readonly"),
      pmRootAutocapitalize: pmRoot.getAttribute("autocapitalize"),
      pmRootAutocorrect: pmRoot.getAttribute("autocorrect"),
      pmRootRole: pmRoot.getAttribute("role"),
      pmRootSpellcheck: pmRoot.getAttribute("spellcheck"),
      pmRootTranslate: pmRoot.getAttribute("translate"),
      wrapperClass: wrapper.className,
      wrapperContain: wrapperStyle.contain,
      wrapperHeight: wrapperStyle.height,
      wrapperOverflow: wrapperStyle.overflow,
      wrapperWidth: wrapperStyle.width,
    };
  });
}
