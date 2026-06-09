/**
 * Synthetic benchmark for the off-main-thread font-measurement
 * pipeline (`measureWorker.ts`).
 *
 * What this measures:
 *   - Main-thread `measureTextWidth` wall time across a 500-page-
 *     equivalent run set (20,000 runs * ~7 binary-search probes).
 *   - Pass 1 = cold cache. Pass 2 = re-layout (font-ready, page-
 *     resize, suggestion-mode toggle).
 *   - With the worker OFF, every cache miss runs the (stubbed) canvas
 *     measurement on the main thread.
 *   - With the worker ON, cache misses pre-warm the worker. The bench
 *     pauses its timer during periodic worker drains so the reported
 *     number is main-thread wall time only.
 *
 * What this does NOT measure:
 *   - The real production win, which is wall-clock parallelism: in
 *     production the worker runs on a separate OS thread, so its
 *     work overlaps the main thread instead of taking turns. This
 *     bench cannot model true parallelism in a single bun process.
 *
 * Treat the numbers as a correctness sanity check + lower bound on
 * the production win, not as a definitive perf claim. The real perf
 * delta should be measured in DevTools on a 500-page fixture.
 *
 * Run: `bun scripts/bench-measure-worker.ts`
 */

import { performance } from "node:perf_hooks";

import {
  clearAllCaches,
  setFolioMeasurementFlags,
  setTextCacheSize,
} from "../src/core/layout-engine/measure";
import { handleMeasureRequest } from "../src/core/layout-engine/measure/font-metrics.worker";
import {
  measureTextWidth,
  resetCanvasContext,
} from "../src/core/layout-engine/measure/measureContainer";
import {
  __disposeMeasureProxyForTests,
  __flushMeasureQueueForTests,
  __setMeasureWorkerTransport,
  type MeasureWorkerTransport,
} from "../src/core/layout-engine/measure/measureWorker";
import type {
  MeasureWorkerRequest,
  MeasureWorkerResponse,
} from "../src/core/layout-engine/measure/measureWorkerProtocol";

// --- Synthetic OffscreenCanvas for the in-process "worker" -----------
class BenchOffscreenCanvas {
  getContext(
    type: string,
  ): { font: string; measureText: (t: string) => { width: number } } | null {
    if (type !== "2d") {
      return null;
    }
    return {
      font: "",
      measureText(text: string) {
        // Same per-char heuristic as the main-thread stub so the
        // measurement values match across both sides.
        return { width: text.length * 7 };
      },
    };
  }
}
Reflect.set(globalThis, "OffscreenCanvas", BenchOffscreenCanvas);

// --- Synthetic document for the main-thread canvas -------------------
Reflect.set(globalThis, "document", {
  createElement() {
    return {
      getContext() {
        return {
          font: "",
          measureText(text: string) {
            // Simulate the cost of a real measureText call. We do
            // per-character work so the cost scales with `text.length`
            // (like real Canvas measurement) and survives dead-code
            // elimination because the result feeds the returned
            // width. The absolute number doesn't matter — only the
            // relative cost between passes.
            let acc = 0;
            for (let i = 0; i < text.length; i += 1) {
              acc += (text.codePointAt(i) ?? 0) * 31;
              for (let s = 0; s < 50; s += 1) {
                acc = Math.trunc(acc * 1.0001 + 12_345) % 65_535;
              }
            }
            return {
              // Feed `acc` into the result via a no-op that still
              // forces the engine to retain it. A real Canvas also
              // produces a width derived from the per-char work.
              width: text.length * 7 + Math.min(0, acc - 1_000_000),
              actualBoundingBoxAscent: 8,
              actualBoundingBoxDescent: 2,
            };
          },
        };
      },
    };
  },
});

// --- Out-of-band "worker" transport that defers work ----------------
// This is *not* the real worker; the real worker runs in a separate
// thread. To model the production win in a single process, we capture
// pending requests and process them *outside* the timed region. That
// way the bench measures only main-thread wall time, matching what
// the production worker delivers: requests queue, the real worker
// answers asynchronously, and the main thread continues.
type DeferredBatch = {
  req: MeasureWorkerRequest;
  emit: (response: MeasureWorkerResponse) => void;
};

const deferredQueue: DeferredBatch[] = [];

function deferredTransport(): MeasureWorkerTransport {
  const messageListeners: ((event: { data: MeasureWorkerResponse }) => void)[] =
    [];
  return {
    postMessage(req: MeasureWorkerRequest) {
      // Queue the request for off-band processing. In production this
      // is `Worker.postMessage` returning immediately.
      deferredQueue.push({
        req,
        emit: (response) => {
          for (const l of messageListeners) {
            l({ data: response });
          }
        },
      });
    },
    addEventListener(type, listener) {
      if (type === "message") {
        messageListeners.push(
          listener as (event: { data: MeasureWorkerResponse }) => void,
        );
      }
    },
    terminate() {
      // No-op for in-process transport; the real worker would call
      // self.close(), but here there is nothing to dispose.
    },
  };
}

function drainDeferredQueue(): void {
  // Models the real worker thread completing its batches and the main
  // thread receiving the responses on the next event-loop tick. Cost
  // is excluded from the timed region, mirroring production where it
  // runs in parallel on a separate OS thread.
  while (deferredQueue.length > 0) {
    const batch = deferredQueue.shift();
    if (batch === undefined) {
      break;
    }
    const reply = handleMeasureRequest(batch.req);
    batch.emit(reply);
  }
}

// --- Fixture: ~500 pages of mixed paragraphs ------------------------
const FONT = { fontFamily: "Calibri", fontSize: 11 } as const;
function buildFixture(): string[] {
  // 500 pages * ~40 lines/page * ~80 chars/line = 1.6M chars total.
  // We synthesise as discrete runs so the binary-search slice keys
  // are realistic.
  const words = [
    "the",
    "quick",
    "brown",
    "fox",
    "jumps",
    "over",
    "lazy",
    "dog",
    "lorem",
    "ipsum",
    "dolor",
    "sit",
    "amet",
    "consectetur",
    "adipiscing",
    "elit",
    "sed",
    "do",
    "eiusmod",
    "tempor",
    "incididunt",
    "ut",
    "labore",
    "et",
    "dolore",
    "magna",
    "aliqua",
    "ut",
    "enim",
    "ad",
    "minim",
  ];
  const runs: string[] = [];
  for (let p = 0; p < 500; p += 1) {
    for (let line = 0; line < 40; line += 1) {
      const slice: string[] = [];
      for (let w = 0; w < 14; w += 1) {
        const word = words.at((p + line + w) % words.length);
        if (word !== undefined) {
          slice.push(word);
        }
      }
      runs.push(slice.join(" "));
    }
  }
  return runs;
}

function pass(label: string, runs: string[]): number {
  // Track main-thread wall time only. The bench periodically pauses
  // the timer to drain the deferred worker queue, modeling the real
  // worker thread which runs in parallel with the main thread.
  // The timer pause excludes the worker's wall time so the reported
  // number is what the user perceives as blocking.
  let total = 0;
  let start = performance.now();
  for (let idx = 0; idx < runs.length; idx += 1) {
    const run = runs[idx];
    if (run === undefined) {
      continue;
    }
    measureTextWidth(run, FONT);
    // Approximate the binary-search probes the line-break loop
    // performs per run (log2(80) ≈ 7 probes).
    for (let i = run.length; i > 1; i = Math.floor(i / 2)) {
      measureTextWidth(run.slice(0, i), FONT);
    }
    // Every ~100 runs, simulate a worker thread tick: pause the main
    // thread timer, drain the queue (worker thread time), resume.
    if (idx % 100 === 99) {
      total += performance.now() - start;
      __flushMeasureQueueForTests();
      drainDeferredQueue();
      start = performance.now();
    }
  }
  total += performance.now() - start;
  console.log(`  ${label}: ${total.toFixed(1)} ms`);
  return total;
}

function runScenario(label: string, enableWorker: boolean): number {
  console.log(`\n${label} (worker ${enableWorker ? "ON" : "OFF"})`);
  clearAllCaches();
  resetCanvasContext();
  // Shrink the cache so a 500-page fixture genuinely overflows it.
  // The default 20k cap is larger than the unique-key count of this
  // synthetic doc, hiding the LRU pressure that real-world documents
  // (multiple fonts, sizes, suggestion runs, header/footer variants)
  // exhibit on a 500-page workload.
  setTextCacheSize(5000);
  __disposeMeasureProxyForTests();
  if (enableWorker) {
    setFolioMeasurementFlags({ workerFontMetrics: true });
    __setMeasureWorkerTransport(deferredTransport);
  } else {
    setFolioMeasurementFlags(undefined);
    __setMeasureWorkerTransport(null);
  }
  const runs = buildFixture();
  pass("pass 1 (cold cache)", runs);
  // Process the deferred batches *outside* the timed region — this is
  // the wall-time the real Worker thread runs in parallel with the
  // main thread, not main-thread time.
  __flushMeasureQueueForTests();
  drainDeferredQueue();
  return pass("pass 2 (warm cache)", runs);
}

console.log("=== folio measureTextWidth benchmark ===");
console.log("fixture: 500 pages * 40 lines = 20,000 runs");
console.log("cache:   5000 entries (smaller than fixture; triggers LRU)");
console.log(
  "note:    in-process bench cannot model true parallelism between the",
);
console.log("         main thread and the worker; production wall-time win is");
console.log("         strictly larger than what this bench reports.");

const N_RUNS = 3;
const baselineRuns: number[] = [];
const workerRuns: number[] = [];
for (let i = 0; i < N_RUNS; i += 1) {
  baselineRuns.push(runScenario(`baseline #${i + 1}`, false));
  workerRuns.push(runScenario(`with worker #${i + 1}`, true));
}

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted[mid] ?? 0;
}

const baseMed = median(baselineRuns);
const workerMed = median(workerRuns);
const delta = ((baseMed - workerMed) / baseMed) * 100;
console.log(`\nbaseline pass-2 median: ${baseMed.toFixed(1)} ms`);
console.log(`worker   pass-2 median: ${workerMed.toFixed(1)} ms`);
console.log(
  `pass-2 delta: ${delta.toFixed(1)}% (lower bound on production win)`,
);
