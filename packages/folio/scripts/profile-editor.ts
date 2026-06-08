import { chromium, type BrowserContext, type Page } from "@playwright/test";
import { TaggedError } from "better-result";
import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

import type {
  HiddenEditorPhase,
  HiddenEditorStateReason,
  LayoutInstrumentation,
  LayoutPhase,
  LayoutRunReason,
} from "../src/core/layout-engine/layoutInstrumentation";
import type { CounterBucket } from "../tests/support/layoutMeasurement";

type PerfStats = {
  pages: number;
  renderedPages: number;
  elements: number;
  hiddenPmElements: number;
  visiblePageElements: number;
  measureText: CounterBucket;
  getBoundingClientRect: CounterBucket;
  createElement: CounterBucket;
  hiddenEditorPhases: Record<HiddenEditorPhase, CounterBucket>;
  hiddenStateCreations: Record<HiddenEditorStateReason, number>;
  measureBlockCalls: number;
  layoutCompletions: number;
  layoutErrors: { message: string; reason: LayoutRunReason }[];
  layoutPhases: Record<LayoutPhase, CounterBucket>;
  layoutReasons: Record<LayoutRunReason, number>;
  longTasks: {
    count: number;
    maxMs: number;
    totalMs: number;
  };
};

type BrowserMetrics = {
  JSHeapUsedSize?: number;
  LayoutDuration?: number;
  RecalcStyleDuration?: number;
  ScriptDuration?: number;
  TaskDuration?: number;
};

type PerfResult = {
  name: string;
  wallMs: number;
  browser: {
    jsHeapMb: number;
    layoutMs: number;
    scriptMs: number;
    styleMs: number;
    taskMs: number;
  };
  stats: PerfStats;
};

class FolioPerfError extends TaggedError("FolioPerfError")<{
  message: string;
  cause?: unknown;
}>() {}

const HOST = "127.0.0.1";
const DEFAULT_PORT = 4201;
const port = Number(process.env["FOLIO_PERF_PORT"] ?? DEFAULT_PORT);
const baseUrl = process.env["FOLIO_PERF_URL"] ?? `http://${HOST}:${port}`;
const skipBuild = process.env["FOLIO_PERF_SKIP_BUILD"] === "1";
const fixtureNames = ["podily-bps.docx", "docx-editor-demo.docx"] as const;

declare global {
  // Browser-side globals installed with addInitScript.
  var __folioPerfCounters: PerfStats | undefined;
  var __resetFolioPerfCounters: (() => void) | undefined;
  var __folioLayoutInstrumentation: LayoutInstrumentation | undefined;
}

async function main() {
  let previewProcess: ReturnType<typeof spawn> | null = null;

  try {
    if (!process.env["FOLIO_PERF_URL"]) {
      if (!skipBuild) {
        await runCommand("bun", ["--filter", "@stll/playground", "build"], {
          cwd: rootDir(),
        });
      }

      previewProcess = spawn(
        "bunx",
        ["vite", "preview", "--host", HOST, "--port", String(port)],
        {
          cwd: `${rootDir()}/apps/playground`,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      await waitForServer(baseUrl);
    }

    const results = await profileScenarios();
    printSummary(results);
    console.log(JSON.stringify(results, null, 2));
  } finally {
    if (previewProcess) {
      previewProcess.kill();
    }
  }
}

function rootDir(): string {
  let dir = fileURLToPath(new URL("../../..", import.meta.url));
  while (dir.endsWith("/") || dir.endsWith("\\")) {
    dir = dir.slice(0, -1);
  }
  return dir;
}

async function runCommand(
  command: string,
  args: string[],
  options: { cwd: string },
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new FolioPerfError({
          message: `${command} ${args.join(" ")} exited with ${code}`,
        }),
      );
    });
  });
}

async function waitForServer(url: string): Promise<void> {
  const startedAt = performance.now();
  while (performance.now() - startedAt < 15_000) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Server not ready yet.
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });
  }
  throw new FolioPerfError({ message: `Timed out waiting for ${url}` });
}

async function profileScenarios(): Promise<PerfResult[]> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    deviceScaleFactor: 2,
    viewport: { height: 900, width: 1280 },
  });

  await installCounters(context);

  try {
    const results: PerfResult[] = [];

    for (const fixtureName of fixtureNames) {
      results.push(
        await profileLoad(
          context,
          `load ${fixtureName}`,
          `/?file=${fixtureName}`,
          1,
        ),
      );
    }

    results.push(
      await profileLoad(
        context,
        "load generated 1500 paragraphs",
        "/?paragraphs=1500",
        20,
      ),
    );

    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable");
    await page.goto(`${baseUrl}/?paragraphs=1500`);
    await waitForEditor(page, 20);

    results.push(
      await profileAction("typing abc immediate path", page, cdp, async () => {
        await page
          .locator(".layout-page")
          .first()
          .click({ position: { x: 120, y: 120 } });
        await page.keyboard.type("abc", { delay: 20 });
        await page.waitForTimeout(75);
      }),
    );

    results.push(
      await profileAction("typing idle reconcile", page, cdp, async () => {
        await page.waitForTimeout(400);
      }),
    );

    await page.close();
    return results;
  } finally {
    await browser.close();
  }
}

async function profileLoad(
  context: BrowserContext,
  name: string,
  path: string,
  minimumPages: number,
): Promise<PerfResult> {
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");

  try {
    return await profileAction(name, page, cdp, async () => {
      await page.goto(`${baseUrl}${path}`);
      await waitForEditor(page, minimumPages);
    });
  } finally {
    await page.close();
  }
}

async function profileAction(
  name: string,
  page: Page,
  cdp: Awaited<ReturnType<BrowserContext["newCDPSession"]>>,
  action: () => Promise<void>,
): Promise<PerfResult> {
  await page.evaluate(() => globalThis.__resetFolioPerfCounters?.());

  const before = await readMetrics(cdp);
  const startedAt = performance.now();
  await action();
  const wallMs = performance.now() - startedAt;
  const after = await readMetrics(cdp);

  return {
    name,
    wallMs: round(wallMs),
    browser: metricDelta(before, after),
    stats: await readStats(page),
  };
}

async function readMetrics(
  cdp: Awaited<ReturnType<BrowserContext["newCDPSession"]>>,
): Promise<BrowserMetrics> {
  const result = await cdp.send("Performance.getMetrics");
  return Object.fromEntries(
    result.metrics.map((metric) => [metric.name, metric.value]),
  );
}

function metricDelta(before: BrowserMetrics, after: BrowserMetrics) {
  return {
    taskMs: round(
      ((after.TaskDuration ?? 0) - (before.TaskDuration ?? 0)) * 1000,
    ),
    scriptMs: round(
      ((after.ScriptDuration ?? 0) - (before.ScriptDuration ?? 0)) * 1000,
    ),
    layoutMs: round(
      ((after.LayoutDuration ?? 0) - (before.LayoutDuration ?? 0)) * 1000,
    ),
    styleMs: round(
      ((after.RecalcStyleDuration ?? 0) - (before.RecalcStyleDuration ?? 0)) *
        1000,
    ),
    jsHeapMb: round((after.JSHeapUsedSize ?? 0) / 1024 / 1024),
  };
}

async function waitForEditor(page: Page, minimumPages: number): Promise<void> {
  await page.waitForSelector('[data-testid="folio-editor"]', {
    timeout: 20_000,
  });
  try {
    await page.waitForFunction(
      (pageCount) =>
        document.querySelectorAll(".layout-page").length >= pageCount,
      minimumPages,
      { timeout: 20_000 },
    );
  } catch (error) {
    const layoutErrors = await page.evaluate(
      () => globalThis.__folioPerfCounters?.layoutErrors ?? [],
    );
    throw new FolioPerfError({
      message: `Timed out waiting for ${minimumPages} layout pages. Layout errors: ${JSON.stringify(layoutErrors)}`,
      cause: error,
    });
  }
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await page.waitForTimeout(250);
}

async function readStats(page: Page): Promise<PerfStats> {
  const stats = await page.evaluate(() => {
    const perf = globalThis.__folioPerfCounters;
    if (!perf) {
      return null;
    }
    return {
      pages: document.querySelectorAll(".layout-page").length,
      renderedPages: document.querySelectorAll(".layout-page-content").length,
      elements: document.querySelectorAll("*").length,
      hiddenPmElements: document.querySelectorAll(".paged-editor__hidden-pm *")
        .length,
      visiblePageElements: document.querySelectorAll(".paged-editor__pages *")
        .length,
      measureText: {
        count: perf.measureText.count,
        totalMs: roundInBrowser(perf.measureText.totalMs),
      },
      getBoundingClientRect: {
        count: perf.getBoundingClientRect.count,
        totalMs: roundInBrowser(perf.getBoundingClientRect.totalMs),
      },
      createElement: {
        count: perf.createElement.count,
        totalMs: roundInBrowser(perf.createElement.totalMs),
      },
      hiddenStateCreations: perf.hiddenStateCreations,
      hiddenEditorPhases: {
        "editor-state": roundBucket(perf.hiddenEditorPhases["editor-state"]),
        "editor-view": roundBucket(perf.hiddenEditorPhases["editor-view"]),
        "to-prose-doc": roundBucket(perf.hiddenEditorPhases["to-prose-doc"]),
        "update-state": roundBucket(perf.hiddenEditorPhases["update-state"]),
      },
      measureBlockCalls: perf.measureBlockCalls,
      layoutCompletions: perf.layoutCompletions,
      layoutErrors: perf.layoutErrors,
      layoutPhases: {
        "flow-blocks": roundBucket(perf.layoutPhases["flow-blocks"]),
        "header-footer": roundBucket(perf.layoutPhases["header-footer"]),
        "initial-fonts": roundBucket(perf.layoutPhases["initial-fonts"]),
        "layout-document": roundBucket(perf.layoutPhases["layout-document"]),
        "measure-blocks": roundBucket(perf.layoutPhases["measure-blocks"]),
        "render-pages": roundBucket(perf.layoutPhases["render-pages"]),
      },
      layoutReasons: perf.layoutReasons,
      longTasks: {
        count: perf.longTasks.count,
        maxMs: roundInBrowser(perf.longTasks.maxMs),
        totalMs: roundInBrowser(perf.longTasks.totalMs),
      },
    };

    function roundInBrowser(value: number): number {
      return Number(value.toFixed(2));
    }

    function roundBucket(bucket: CounterBucket): CounterBucket {
      return {
        count: bucket.count,
        totalMs: roundInBrowser(bucket.totalMs),
      };
    }
  });

  if (!stats) {
    throw new FolioPerfError({
      message: "Folio perf counters were not installed",
    });
  }

  return stats;
}

async function installCounters(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    type BrowserPerfStats = PerfStats & {
      longTaskDurations: number[];
    };

    const makeLayoutPhaseCounters = (): Record<LayoutPhase, CounterBucket> => ({
      "flow-blocks": { count: 0, totalMs: 0 },
      "header-footer": { count: 0, totalMs: 0 },
      "initial-fonts": { count: 0, totalMs: 0 },
      "layout-document": { count: 0, totalMs: 0 },
      "measure-blocks": { count: 0, totalMs: 0 },
      "render-pages": { count: 0, totalMs: 0 },
    });
    const makeHiddenEditorPhaseCounters = (): Record<
      HiddenEditorPhase,
      CounterBucket
    > => ({
      "editor-state": { count: 0, totalMs: 0 },
      "editor-view": { count: 0, totalMs: 0 },
      "to-prose-doc": { count: 0, totalMs: 0 },
      "update-state": { count: 0, totalMs: 0 },
    });
    const makeHiddenStateCreationCounters = (): Record<
      HiddenEditorStateReason,
      number
    > => ({
      "external-document": 0,
      mount: 0,
    });

    const makeCounters = (): BrowserPerfStats => ({
      createElement: { count: 0, totalMs: 0 },
      elements: 0,
      getBoundingClientRect: { count: 0, totalMs: 0 },
      hiddenEditorPhases: makeHiddenEditorPhaseCounters(),
      hiddenStateCreations: makeHiddenStateCreationCounters(),
      hiddenPmElements: 0,
      layoutCompletions: 0,
      layoutErrors: [],
      layoutPhases: makeLayoutPhaseCounters(),
      layoutReasons: {
        "font-ready": 0,
        initial: 0,
        "layout-input": 0,
        manual: 0,
        transaction: 0,
      },
      longTaskDurations: [],
      longTasks: { count: 0, maxMs: 0, totalMs: 0 },
      measureBlockCalls: 0,
      measureText: { count: 0, totalMs: 0 },
      pages: 0,
      renderedPages: 0,
      visiblePageElements: 0,
    });

    globalThis.__folioPerfCounters = makeCounters();
    globalThis.__resetFolioPerfCounters = () => {
      globalThis.__folioPerfCounters = makeCounters();
      globalThis.__folioLayoutMeasurementStats = {
        layoutCompletions: 0,
        layoutErrors: [],
        layoutPhases: makeLayoutPhaseCounters(),
        layoutReasons: makeCounters().layoutReasons,
        hiddenEditorPhases: makeHiddenEditorPhaseCounters(),
        hiddenStateCreations: makeHiddenStateCreationCounters(),
        measureBlockCalls: 0,
      };
    };

    globalThis.__folioLayoutMeasurementStats = {
      layoutCompletions: 0,
      layoutErrors: [],
      layoutPhases: makeLayoutPhaseCounters(),
      layoutReasons: makeCounters().layoutReasons,
      hiddenEditorPhases: makeHiddenEditorPhaseCounters(),
      hiddenStateCreations: makeHiddenStateCreationCounters(),
      measureBlockCalls: 0,
    };
    globalThis.__folioLayoutInstrumentation = {
      onHiddenEditorPhase(event) {
        const stats = globalThis.__folioLayoutMeasurementStats;
        if (stats) {
          const bucket = stats.hiddenEditorPhases[event.phase];
          bucket.count += 1;
          bucket.totalMs += event.durationMs;
        }
        const perf = globalThis.__folioPerfCounters;
        if (perf) {
          const bucket = perf.hiddenEditorPhases[event.phase];
          bucket.count += 1;
          bucket.totalMs += event.durationMs;
        }
      },
      onHiddenEditorStateCreate(event) {
        const stats = globalThis.__folioLayoutMeasurementStats;
        if (stats) {
          stats.hiddenStateCreations[event.reason] += 1;
        }
        const perf = globalThis.__folioPerfCounters;
        if (perf) {
          perf.hiddenStateCreations[event.reason] += 1;
        }
      },
      onLayoutComplete(event) {
        const stats = globalThis.__folioLayoutMeasurementStats;
        if (stats) {
          stats.layoutCompletions += 1;
          stats.layoutReasons[event.reason] += 1;
        }
        const perf = globalThis.__folioPerfCounters;
        if (perf) {
          perf.layoutCompletions += 1;
          perf.layoutReasons[event.reason] += 1;
        }
      },
      onLayoutError(event) {
        const stats = globalThis.__folioLayoutMeasurementStats;
        if (stats) {
          stats.layoutErrors.push(event);
        }
        const perf = globalThis.__folioPerfCounters;
        if (perf) {
          perf.layoutErrors.push(event);
        }
      },
      onLayoutPhase(event) {
        const stats = globalThis.__folioLayoutMeasurementStats;
        if (stats) {
          const bucket = stats.layoutPhases[event.phase];
          bucket.count += 1;
          bucket.totalMs += event.durationMs;
        }
        const perf = globalThis.__folioPerfCounters;
        if (perf) {
          const bucket = perf.layoutPhases[event.phase];
          bucket.count += 1;
          bucket.totalMs += event.durationMs;
        }
      },
      onMeasureBlock() {
        const stats = globalThis.__folioLayoutMeasurementStats;
        if (stats) {
          stats.measureBlockCalls += 1;
        }
        const perf = globalThis.__folioPerfCounters;
        if (perf) {
          perf.measureBlockCalls += 1;
        }
      },
    };

    const measureTextDescriptor = Object.getOwnPropertyDescriptor(
      CanvasRenderingContext2D.prototype,
      "measureText",
    );
    const measureText = measureTextDescriptor?.value;
    if (typeof measureText === "function") {
      Object.defineProperty(CanvasRenderingContext2D.prototype, "measureText", {
        ...measureTextDescriptor,
        value(this: CanvasRenderingContext2D, text: string) {
          const startedAt = performance.now();
          try {
            return Reflect.apply(measureText, this, [text]);
          } finally {
            recordBucket("measureText", performance.now() - startedAt);
          }
        },
      });
    }

    const rectDescriptor = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "getBoundingClientRect",
    );
    const rect = rectDescriptor?.value;
    if (typeof rect === "function") {
      Object.defineProperty(Element.prototype, "getBoundingClientRect", {
        ...rectDescriptor,
        value(this: Element) {
          const startedAt = performance.now();
          try {
            return Reflect.apply(rect, this, []);
          } finally {
            recordBucket(
              "getBoundingClientRect",
              performance.now() - startedAt,
            );
          }
        },
      });
    }

    const createElementDescriptor = Object.getOwnPropertyDescriptor(
      Document.prototype,
      "createElement",
    );
    const createElement = createElementDescriptor?.value;
    if (typeof createElement === "function") {
      Object.defineProperty(Document.prototype, "createElement", {
        ...createElementDescriptor,
        value(...args: unknown[]) {
          const startedAt = performance.now();
          try {
            return Reflect.apply(createElement, this, args);
          } finally {
            recordBucket("createElement", performance.now() - startedAt);
          }
        },
      });
    }

    try {
      new PerformanceObserver((list) => {
        const perf = globalThis.__folioPerfCounters;
        if (!perf) {
          return;
        }
        for (const entry of list.getEntries()) {
          perf.longTasks.count += 1;
          perf.longTasks.totalMs += entry.duration;
          perf.longTasks.maxMs = Math.max(perf.longTasks.maxMs, entry.duration);
        }
      }).observe({ entryTypes: ["longtask"] });
    } catch {
      // Long task entries are not available in every browser mode.
    }

    function recordBucket(
      key: "createElement" | "getBoundingClientRect" | "measureText",
      elapsedMs: number,
    ): void {
      const perf = globalThis.__folioPerfCounters;
      if (!perf) {
        return;
      }
      perf[key].count += 1;
      perf[key].totalMs += elapsedMs;
    }
  });
}

function printSummary(results: PerfResult[]): void {
  console.table(
    results.map((result) => ({
      scenario: result.name,
      wallMs: result.wallMs,
      taskMs: result.browser.taskMs,
      scriptMs: result.browser.scriptMs,
      layoutMs: result.browser.layoutMs,
      pages: result.stats.pages,
      rendered: result.stats.renderedPages,
      phases: formatLayoutPhases(result.stats.layoutPhases),
      hiddenStates: JSON.stringify(result.stats.hiddenStateCreations),
      hiddenPhases: formatBuckets(result.stats.hiddenEditorPhases),
      measureBlocks: result.stats.measureBlockCalls,
      hiddenEls: result.stats.hiddenPmElements,
      visibleEls: result.stats.visiblePageElements,
      reasons: JSON.stringify(result.stats.layoutReasons),
      errors: JSON.stringify(result.stats.layoutErrors),
      measureText: result.stats.measureText.count,
      longTaskMs: result.stats.longTasks.totalMs,
    })),
  );
}

function formatLayoutPhases(
  phases: Record<LayoutPhase, CounterBucket>,
): string {
  return formatBuckets(phases);
}

function formatBuckets<TPhase extends string>(
  phases: Record<TPhase, CounterBucket>,
): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(phases).map(([phase, bucket]) => [
        phase,
        `${bucket.count}x ${round(bucket.totalMs)}ms`,
      ]),
    ),
  );
}

function round(value: number): number {
  return Number(value.toFixed(2));
}

await main();
