import { chromium } from "@playwright/test";
import { panic } from "better-result";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { DIAGRAM_FIXTURES } from "../src/components/ai-elements/mermaid-diagram.fixtures";

const WEB_ROOT = fileURLToPath(new URL("../", import.meta.url));
const OUT_DIR = path.join(WEB_ROOT, ".cache/diagram-render-bench");
const WARM_RUNS = Number(process.env["WARM_RUNS"] ?? "10");
const CHROMIUM_EXECUTABLE_PATH = process.env["CHROMIUM_EXECUTABLE_PATH"];

const RENDERER_NAMES = ["mermaid", "pele"] as const;

type RendererName = (typeof RENDERER_NAMES)[number];

const RENDERERS = {
  mermaid: `import { mermaid } from "@streamdown/mermaid";
const instance = mermaid.getMermaid();
export const renderDiagram = async (id, source) => (await instance.render(id, source)).svg;`,
  pele: `import { mermaidDiagram } from "${path.join(WEB_ROOT, "src/components/ai-elements/mermaid-diagram.ts")}";
const instance = mermaidDiagram.getMermaid();
export const renderDiagram = async (id, source) => (await instance.render(id, source)).svg;`,
} as const satisfies Record<RendererName, string>;

const entryPath = (renderer: RendererName) =>
  `/${renderer}/diagram-render-bench-${renderer}.js`;

type DiagramTiming = { name: string; coldMs: number; warmMedianMs: number };

type RendererReport = {
  renderer: RendererName;
  importMs: number;
  heapAfterImportKiB: number;
  heapRetainedKiB: number;
  fetchedFiles: number;
  fetchedGzipKiB: number;
  timings: DiagramTiming[];
};

const median = (values: readonly number[]) =>
  values.toSorted((a, b) => a - b).at(Math.floor(values.length / 2)) ??
  Number.NaN;

const bundle = async (renderer: RendererName) => {
  const dir = path.join(OUT_DIR, renderer);
  mkdirSync(dir, { recursive: true });
  const entry = path.join(
    WEB_ROOT,
    `.cache/diagram-render-bench-${renderer}.ts`,
  );
  writeFileSync(entry, RENDERERS[renderer]);
  const result = await Bun.build({
    entrypoints: [entry],
    outdir: dir,
    target: "browser",
    splitting: true,
    minify: true,
    naming: "[name].[ext]",
  });
  rmSync(entry);
  if (!result.success) {
    panic(`bundling ${renderer} failed`, result.logs);
  }
};

rmSync(OUT_DIR, { recursive: true, force: true });
for (const renderer of RENDERER_NAMES) {
  await bundle(renderer);
}

const fetched: string[] = [];
const server = Bun.serve({
  port: 0,
  fetch: ({ url }) => {
    const { pathname } = new URL(url);
    if (pathname === "/") {
      return new Response(
        '<!doctype html><html><head><meta charset="utf-8"></head><body style="font-family: sans-serif"></body></html>',
        { headers: { "content-type": "text/html" } },
      );
    }
    if (
      !RENDERER_NAMES.some((renderer) => pathname.startsWith(`/${renderer}/`))
    ) {
      return new Response(null, { status: 404 });
    }
    fetched.push(pathname);
    return new Response(Bun.file(path.join(OUT_DIR, pathname)), {
      headers: { "content-type": "text/javascript" },
    });
  },
});

const browser = await chromium.launch(
  CHROMIUM_EXECUTABLE_PATH === undefined
    ? {}
    : { executablePath: CHROMIUM_EXECUTABLE_PATH },
);

const measure = async (renderer: RendererName): Promise<RendererReport> => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const heap = async () => {
    await cdp.send("HeapProfiler.collectGarbage");
    return (await cdp.send("Runtime.getHeapUsage")).usedSize;
  };
  fetched.length = 0;
  await page.goto(server.url.href, {
    waitUntil: "domcontentloaded",
  });
  const baseHeap = await heap();
  const importMs = await page.evaluate(async (src) => {
    const start = performance.now();
    await import(src);
    return performance.now() - start;
  }, entryPath(renderer));
  const heapAfterImport = await heap();
  const timings: DiagramTiming[] = [];
  for (const { name, source } of DIAGRAM_FIXTURES) {
    const samples = await page.evaluate(
      async ({ src, text, runs }) => {
        const { renderDiagram } = await import(src);
        const durations: number[] = [];
        for (let run = 0; run <= runs; run += 1) {
          const start = performance.now();
          await renderDiagram(`bench-${run}`, text);
          durations.push(performance.now() - start);
        }
        return durations;
      },
      { src: entryPath(renderer), text: source, runs: WARM_RUNS },
    );
    timings.push({
      name,
      coldMs: samples.at(0) ?? Number.NaN,
      warmMedianMs: median(samples.slice(1)),
    });
  }
  const heapRetained = await heap();
  const files = [...new Set(fetched)];
  await context.close();
  return {
    renderer,
    importMs,
    heapAfterImportKiB: (heapAfterImport - baseHeap) / 1024,
    heapRetainedKiB: (heapRetained - baseHeap) / 1024,
    fetchedFiles: files.length,
    fetchedGzipKiB:
      files.reduce(
        (total, file) =>
          total + gzipSync(readFileSync(path.join(OUT_DIR, file))).length,
        0,
      ) / 1024,
    timings,
  };
};

const reports: RendererReport[] = [];
for (const renderer of RENDERER_NAMES) {
  reports.push(await measure(renderer));
}
await browser.close();
await server.stop();

const format = (value: number) => value.toFixed(1);
const header = reports.map(({ renderer }) => renderer);
const lines = [
  `| diagram | ${header.map((name) => `${name} cold / warm (ms)`).join(" | ")} |`,
  `| --- | ${header.map(() => "---").join(" | ")} |`,
  ...DIAGRAM_FIXTURES.map(
    ({ name }, index) =>
      `| ${name} | ${reports
        .map(({ timings }) => {
          const timing = timings.at(index);
          return timing
            ? `${format(timing.coldMs)} / ${format(timing.warmMedianMs)}`
            : "n/a";
        })
        .join(" | ")} |`,
  ),
  "",
  "| renderer | import (ms) | heap after import (KiB) | heap retained (KiB) | JS fetched (files, gzip KiB) |",
  "| --- | --- | --- | --- | --- |",
  ...reports.map(
    (report) =>
      `| ${report.renderer} | ${format(report.importMs)} | ${format(report.heapAfterImportKiB)} | ${format(report.heapRetainedKiB)} | ${report.fetchedFiles}, ${format(report.fetchedGzipKiB)} |`,
  ),
];
console.log(lines.join("\n"));
