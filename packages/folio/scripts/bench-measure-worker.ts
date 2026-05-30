/**
 * Synthetic benchmark for the off-main-thread font-measurement
 * pipeline (`measureWorker.ts`).
 *
 * Generates a 500-page-equivalent stream of paragraph runs and
 * measures the cumulative time spent inside `measureTextWidth` across
 * two layout passes:
 *
 *   pass 1: cold cache — pure main-thread canvas work
 *   pass 2: warm cache — measures landed from pass 1 (plus worker
 *           pre-warms when the flag is ON)
 *
 * The benchmark runs the same payload twice with the flag OFF and
 * twice with the flag ON, and reports the wall-time delta for pass 2.
 * Pass 2 represents the steady-state re-layout the user actually
 * notices (font-ready, page-resize, suggestion-mode toggles).
 *
 * Run: `bun scripts/bench-measure-worker.ts`
 */

import { performance } from "node:perf_hooks";

import {
  clearAllCaches,
  setFolioMeasurementFlags,
} from "../src/core/layout-bridge/measuring";
import {
  measureTextWidth,
  resetCanvasContext,
} from "../src/core/layout-bridge/measuring/measureContainer";
import {
  __disposeMeasureProxyForTests,
  __flushMeasureQueueForTests,
  __setMeasureWorkerTransport,
  type MeasureWorkerTransport,
} from "../src/core/layout-bridge/measuring/measureWorker";
import { handleMeasureRequest } from "../src/core/layout-bridge/measuring/font-metrics.worker";
import type {
  MeasureWorkerRequest,
  MeasureWorkerResponse,
} from "../src/core/layout-bridge/measuring/measureWorkerProtocol";

// --- Synthetic OffscreenCanvas for the in-process "worker" -----------
(globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = class {
  constructor(_w: number, _h: number) {}
  getContext(type: string) {
    if (type !== "2d") return null;
    return {
      font: "",
      measureText(text: string) {
        // Same per-char heuristic as the main-thread stub so the
        // measurement values match across both sides.
        return { width: text.length * 7 };
      },
    };
  }
};

// --- Synthetic document for the main-thread canvas -------------------
(globalThis as { document?: unknown }).document = {
  createElement() {
    return {
      getContext() {
        return {
          font: "",
          measureText(text: string) {
            // Simulate the cost of a real measureText call. The
            // absolute number doesn't matter — only the relative cost
            // between passes. We use a small integer-CPU loop instead
            // of `performance.now()` polling to keep the benchmark
            // fast and noise-free.
            let acc = 0;
            for (let i = 0; i < 500; i += 1) {
              acc += (i * 31) & 0xff;
            }
            return {
              // `text.length * 7 + acc & 0` keeps the optimiser from
              // dead-coding the spin.
              width: text.length * 7 + (acc & 0),
              actualBoundingBoxAscent: 8,
              actualBoundingBoxDescent: 2,
            };
          },
        };
      },
    };
  },
};

// --- In-process "worker" transport that resolves synchronously -------
// This is *not* the real worker; the real worker runs in a separate
// thread. For benchmarking purposes the substitution is fair: the only
// thing we are measuring is "did the cache get filled before pass 2?",
// which is true in both the synthetic and the real case. The real
// worker additionally moves the work off the main thread, which is the
// production win that this benchmark cannot model in-process.
function inProcessTransport(): MeasureWorkerTransport {
  const messageListeners: ((event: {
    data: MeasureWorkerResponse;
  }) => void)[] = [];
  return {
    postMessage(req: MeasureWorkerRequest) {
      // Synchronously deliver the response. The main thread will write
      // the values into the cache via setCachedTextWidth.
      const reply = handleMeasureRequest(req);
      for (const l of messageListeners) {
        l({ data: reply });
      }
    },
    addEventListener(type, listener) {
      if (type === "message") {
        messageListeners.push(
          listener as (event: { data: MeasureWorkerResponse }) => void,
        );
      }
    },
    terminate() {},
  };
}

// --- Fixture: ~500 pages of mixed paragraphs ------------------------
const FONT = { fontFamily: "Calibri", fontSize: 11 } as const;
function buildFixture(): string[] {
  // 500 pages * ~40 lines/page * ~80 chars/line = 1.6M chars total.
  // We synthesise as discrete runs so the binary-search slice keys
  // are realistic.
  const words = [
    "the", "quick", "brown", "fox", "jumps", "over", "lazy", "dog",
    "lorem", "ipsum", "dolor", "sit", "amet", "consectetur", "adipiscing",
    "elit", "sed", "do", "eiusmod", "tempor", "incididunt", "ut", "labore",
    "et", "dolore", "magna", "aliqua", "ut", "enim", "ad", "minim",
  ];
  const runs: string[] = [];
  for (let p = 0; p < 500; p += 1) {
    for (let line = 0; line < 40; line += 1) {
      const slice: string[] = [];
      for (let w = 0; w < 14; w += 1) {
        slice.push(words[(p + line + w) % words.length]!);
      }
      runs.push(slice.join(" "));
    }
  }
  return runs;
}

function pass(label: string, runs: string[]): number {
  const start = performance.now();
  for (const run of runs) {
    measureTextWidth(run, FONT);
    // Approximate the binary-search probes the line-break loop
    // performs per run (log2(80) ≈ 7 probes).
    for (let i = run.length; i > 1; i = Math.floor(i / 2)) {
      measureTextWidth(run.slice(0, i), FONT);
    }
  }
  const ms = performance.now() - start;
  console.log(`  ${label}: ${ms.toFixed(1)} ms`);
  return ms;
}

function runScenario(label: string, enableWorker: boolean): number {
  console.log(`\n${label} (worker ${enableWorker ? "ON" : "OFF"})`);
  clearAllCaches();
  resetCanvasContext();
  __disposeMeasureProxyForTests();
  if (enableWorker) {
    setFolioMeasurementFlags({ workerFontMetrics: true });
    __setMeasureWorkerTransport(inProcessTransport);
  } else {
    setFolioMeasurementFlags(undefined);
    __setMeasureWorkerTransport(null);
  }
  const runs = buildFixture();
  pass("pass 1 (cold cache)", runs);
  // Drain any worker requests so the cache fills before pass 2.
  __flushMeasureQueueForTests();
  return pass("pass 2 (warm cache)", runs);
}

console.log("=== folio measureTextWidth benchmark ===");
console.log("fixture: 500 pages * 40 lines = 20,000 runs");
const baseline = runScenario("baseline", false);
const withWorker = runScenario("with worker", true);
const delta = ((baseline - withWorker) / baseline) * 100;
console.log(
  `\npass-2 delta: ${delta.toFixed(1)}% reduction (worker fills cache so re-layout skips main-thread canvas)`,
);
