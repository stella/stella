/**
 * Measurements for the Typst invoice renderer spike. Dev-only; not part of
 * any route or CI job.
 *
 *   bun scripts/typst-invoice-spike.ts <out-dir>            all modes, one process each
 *   bun scripts/typst-invoice-spike.ts <out-dir> wasm|browser
 *
 * Each mode runs in a fresh process so cold timings and peak RSS are not
 * shared. PDFs are written to <out-dir> for external validation (veraPDF).
 */
import { PDF } from "@libpdf/core";
import { panic } from "better-result";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";

import { childExitStatus } from "@stll/scripts/src/child-exit-status";

import type { RenderInvoicePdfOptions } from "@/api/lib/billing/invoice-pdf/render-helpers";
import { TYPST_FONT_PATHS } from "@/api/lib/billing/invoice-pdf/typst/compiler";
import { buildInvoiceTemplateData } from "@/api/lib/billing/invoice-pdf/typst/data";
import {
  CEE_DIACRITICS,
  DUMMY_ISDOC,
  invoiceFixture,
} from "@/api/lib/billing/invoice-pdf/typst/fixtures";
import { toPdfA3 } from "@/api/lib/billing/invoice-pdf/typst/pdfa";
import {
  loadDefaultInvoiceTemplate,
  renderInvoiceWithTypst,
} from "@/api/lib/billing/invoice-pdf/typst/render-typst";
import { openTypstSession } from "@/api/lib/billing/invoice-pdf/typst/session";

const MODES = ["wasm", "browser"] as const;
type Mode = (typeof MODES)[number];

const [outDir = "typst-spike-out", requested] = process.argv.slice(2);
const WARM_RUNS = 10;
const CREATED_AT = new Date("2026-09-30T08:00:00Z");
const FIXTURES = {
  "1-page": invoiceFixture(3),
  "60-lines": invoiceFixture(60),
};
// Typst memoises compilation; a new invoice number per run keeps warm
// timings honest instead of measuring a cache hit.
const variant = (fixture: RenderInvoicePdfOptions, run: number) => ({
  ...fixture,
  invoice: {
    ...fixture.invoice,
    invoiceNumber: `2026-${String(run)}`,
    lines: fixture.invoice.lines.map((line) => ({
      ...line,
      description: `${line.description} (${String(run)})`,
    })),
  },
});

let peakRss = process.memoryUsage.rss();
setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage.rss());
}, 5).unref();

const median = (values: number[]) => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
};
const timed = async <T>(work: () => Promise<T> | T) => {
  const started = performance.now();
  const value = await work();
  return { value, ms: performance.now() - started };
};

const pdfFacts = async (bytes: Uint8Array) => {
  const pdf = await PDF.load(bytes);
  const text = pdf
    .extractText()
    .map(({ text: pageText }) => pageText)
    .join("\n");
  return {
    pages: pdf.getPageCount(),
    diacritics: text.includes(CEE_DIACRITICS),
  };
};

type Row = Record<string, string | number | boolean>;
const report = (mode: Mode, rows: Row[]) => {
  console.log(JSON.stringify({ mode, rows, peakRss }));
};

const wasm = async () => {
  const rows: Row[] = [];
  const attachments = [
    {
      name: "invoice.isdoc",
      bytes: new TextEncoder().encode(DUMMY_ISDOC),
      mimeType: "application/xml",
      description: "ISDOC",
      relationship: "Alternative" as const,
    },
  ];
  for (const [name, fixture] of Object.entries(FIXTURES)) {
    // A fresh renderer process per fixture: the first render pays process
    // start, WASM instantiation and font loading.
    const session = openTypstSession();
    const render = async (run = 0) =>
      renderInvoiceWithTypst({
        invoice: variant(fixture, run),
        session,
        attachments,
        createdAt: CREATED_AT,
      });
    // Only successful renders are timed; a rejection stops the benchmark.
    const rendered = async (run = 0) => {
      const next = await timed(async () => render(run));
      const result = next.value.unwrap(
        "The Typst session renders a spike fixture",
      );
      const value =
        result.status === "rendered"
          ? result
          : panic(result.diagnostics.join("\n"));
      return { value, ms: next.ms };
    };
    const cold = await rendered();
    const outcome = cold.value;
    let rendererPeakRss = outcome.peakRssBytes;
    const warm: number[] = [];
    const compile: number[] = [];
    for (let run = 1; run <= WARM_RUNS; run += 1) {
      const next = await rendered(run);
      compile.push(next.value.compileMs);
      rendererPeakRss = Math.max(rendererPeakRss, next.value.peakRssBytes);
      warm.push(next.ms);
    }
    // Raw Typst output, without PDF/A post-processing, for the size column.
    const data = buildInvoiceTemplateData(fixture).unwrap(
      "A spike fixture builds template data",
    );
    const rawOutcome = await session.render({
      template: await loadDefaultInvoiceTemplate(),
      inputs: { invoice: JSON.stringify(data) },
      format: "pdf",
    });
    const raw =
      rawOutcome.status === "rendered"
        ? rawOutcome
        : panic(rawOutcome.diagnostics.join("\n"));
    rendererPeakRss = Math.max(rendererPeakRss, raw.peakRssBytes);
    const postprocess = await timed(async () =>
      toPdfA3(raw.bytes, {
        title: data.title,
        lang: data.lang,
        createdAt: CREATED_AT,
        attachments,
      }),
    );
    await Bun.write(path.join(outDir, `wasm-${name}.pdf`), outcome.pdf);
    rows.push({
      fixture: name,
      coldMs: cold.ms,
      coldCompileMs: outcome.compileMs,
      warmMs: median(warm),
      warmCompileMs: median(compile),
      postprocessMs: postprocess.ms,
      rawBytes: raw.bytes.byteLength,
      // The renderer is a separate process; this run's own RSS excludes it.
      // Highest across the cold, warm and raw renders.
      rendererPeakRss,
      bytes: outcome.pdf.byteLength,
      ...(await pdfFacts(outcome.pdf)),
    });
    await session.close();
  }
  report("wasm", rows);
};

const browser = async () => {
  const compilerWasm = new Uint8Array(
    await Bun.file(
      new URL(import.meta.resolve("@myriaddreamin/typst-ts-web-compiler/wasm")),
    ).arrayBuffer(),
  );
  const rendererWasm = new Uint8Array(
    await Bun.file(
      new URL(import.meta.resolve("@myriaddreamin/typst-ts-renderer/wasm")),
    ).arrayBuffer(),
  );
  const fonts = await Promise.all(
    TYPST_FONT_PATHS.map(
      async (fontPath) =>
        new Uint8Array(await Bun.file(fontPath).arrayBuffer()),
    ),
  );
  const sizes = (bytes: Uint8Array) => ({
    raw: bytes.byteLength,
    gzip: gzipSync(bytes, { level: 9 }).byteLength,
    brotli: brotliCompressSync(bytes).byteLength,
  });
  const template = await loadDefaultInvoiceTemplate();
  const dataFor = (run: number) =>
    JSON.stringify(
      buildInvoiceTemplateData(variant(FIXTURES["1-page"], run)).unwrap(
        "A spike fixture builds template data",
      ),
    );
  // Cold: instantiate both modules, load fonts, compile to the vector
  // artifact and render every page to SVG, as a preview pane would.
  const started = performance.now();
  const compilerModule = await import("@myriaddreamin/typst-ts-web-compiler");
  await compilerModule.default({ module_or_path: compilerWasm });
  const builder = new compilerModule.TypstCompilerBuilder();
  builder.set_dummy_access_model();
  for (const font of fonts) {
    await builder.add_raw_font(font);
  }
  const compiler = await builder.build();
  const instantiatedMs = performance.now() - started;
  const rendererModule = await import("@myriaddreamin/typst-ts-renderer");
  await rendererModule.default({ module_or_path: rendererWasm });
  const renderer = await new rendererModule.TypstRendererBuilder().build();
  compiler.add_source("/main.typ", template);
  const toSvg = (run: number) => {
    const artifact: unknown = compiler.compile(
      "/main.typ",
      [["invoice", dataFor(run)]],
      "vector",
      2,
    );
    if (
      typeof artifact !== "object" ||
      artifact === null ||
      !("result" in artifact) ||
      !(artifact.result instanceof Uint8Array)
    ) {
      return panic("Vector compile failed");
    }
    const session = renderer.session_from_artifact(artifact.result, "vector");
    const svg = renderer.svg_data(session);
    session.free();
    return svg;
  };
  const svg = toSvg(0);
  const coldMs = performance.now() - started;
  const warm: number[] = [];
  for (let run = 1; run <= WARM_RUNS; run += 1) {
    warm.push((await timed(() => toSvg(run))).ms);
  }
  await Bun.write(path.join(outDir, "browser-1-page.svg"), svg);
  // Each font is a separate file, so compress each and sum.
  const fontSizes = { raw: 0, gzip: 0, brotli: 0 };
  for (const font of fonts) {
    const each = sizes(font);
    fontSizes.raw += each.raw;
    fontSizes.gzip += each.gzip;
    fontSizes.brotli += each.brotli;
  }
  report("browser", [
    { part: "compiler wasm", ...sizes(compilerWasm) },
    { part: "renderer wasm", ...sizes(rendererWasm) },
    { part: "fonts", ...fontSizes },
    {
      part: "svg render (1 page)",
      instantiatedMs,
      coldMs,
      warmMs: median(warm),
      svgBytes: svg.length,
    },
  ]);
};

const runners = { wasm, browser } satisfies Record<Mode, () => Promise<void>>;

await mkdir(outDir, { recursive: true });
const mode = MODES.find((candidate) => candidate === requested);
if (mode === undefined) {
  for (const each of MODES) {
    const child = Bun.spawn(
      [process.execPath, import.meta.path, outDir, each],
      { stdout: "inherit", stderr: "inherit" },
    );
    await child.exited;
    const status = childExitStatus(child);
    if (status !== 0) {
      console.error(`Benchmark mode ${each} exited with ${String(status)}`);
      process.exit(status);
    }
  }
} else {
  await runners[mode]();
}
