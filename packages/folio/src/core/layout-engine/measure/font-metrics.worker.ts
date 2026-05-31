/**
 * Web Worker entry for off-main-thread text-width measurement.
 *
 * The worker holds a single `OffscreenCanvas` 2D context and answers
 * batched `measure` requests. It is a pure function over its inputs —
 * no cache and no font-loading orchestration. The main thread owns all
 * of that.
 *
 * On any failure (no `OffscreenCanvas`, no 2D context), it replies with
 * `ok: false` so the proxy disables itself for the session and every
 * future read falls back to the main-thread canvas.
 *
 * NOTE: this file runs in worker scope. It must not import anything
 * that touches `document`, `window`, or React. The protocol module is
 * deliberately dependency-free.
 */

import { TaggedError } from "better-result";

import {
  WORKER_FONT_FINGERPRINT_TEXT,
  type MeasureRequestEntry,
  type MeasureResponseEntry,
  type MeasureWorkerRequest,
  type MeasureWorkerResponse,
} from "./measureWorkerProtocol";

class WorkerInitError extends TaggedError("WorkerInitError")<{
  message: string;
}>() {}

type WorkerCanvasContext = {
  font: string;
  measureText(text: string): { width: number };
};

let ctx: WorkerCanvasContext | null = null;
let initError: string | null = null;

const FONT_FINGERPRINT_EPSILON = 0.01;

function getCtx(): WorkerCanvasContext {
  if (ctx !== null) {
    return ctx;
  }
  if (initError !== null) {
    throw new WorkerInitError({ message: initError });
  }
  if (typeof OffscreenCanvas === "undefined") {
    initError = "OffscreenCanvas not available in worker scope";
    throw new WorkerInitError({ message: initError });
  }
  const canvas = new OffscreenCanvas(1, 1);
  // `OffscreenCanvasRenderingContext2D` from the worker DOM lib has the
  // same `font` + `measureText` shape we need. We narrow to the minimal
  // surface so the rest of the file does not pull in DOM types.
  const next = canvas.getContext("2d") as unknown as WorkerCanvasContext | null;
  if (next === null) {
    initError = "Failed to acquire OffscreenCanvas 2D context";
    throw new WorkerInitError({ message: initError });
  }
  ctx = next;
  return ctx;
}

function isFontFingerprintMatch(
  context: WorkerCanvasContext,
  expectedWidth: number,
): boolean {
  const actualWidth = context.measureText(WORKER_FONT_FINGERPRINT_TEXT).width;
  const tolerance = Math.max(FONT_FINGERPRINT_EPSILON, expectedWidth * 0.0001);
  return Math.abs(actualWidth - expectedWidth) <= tolerance;
}

function measureEntry(entry: MeasureRequestEntry): MeasureResponseEntry | null {
  const context = getCtx();
  context.font = entry.font;
  if (!isFontFingerprintMatch(context, entry.fontFingerprintWidth)) {
    return null;
  }
  const raw = context.measureText(entry.text).width;
  let width = raw;
  if (entry.letterSpacing !== 0 && entry.text.length > 1) {
    width += entry.letterSpacing * (entry.text.length - 1);
  }
  width *= entry.horizontalScale;
  return {
    text: entry.text,
    fontCacheKey: entry.fontCacheKey,
    letterSpacing: entry.letterSpacing,
    width,
  };
}

/**
 * Test-only: reset the cached OffscreenCanvas context. Used by unit
 * tests that toggle the global `OffscreenCanvas` between cases. The
 * worker itself never needs this — its lifetime is one tab.
 */
export function __resetWorkerCtxForTests(): void {
  ctx = null;
  initError = null;
}

/**
 * Pure-function entry point. Exported so tests can exercise the worker
 * contract without spawning a real `Worker`. Production code only
 * reaches this via `postMessage`.
 */
export function handleMeasureRequest(
  req: MeasureWorkerRequest,
): MeasureWorkerResponse {
  try {
    const entries: MeasureResponseEntry[] = [];
    for (const entry of req.entries) {
      const measured = measureEntry(entry);
      if (measured !== null) {
        entries.push(measured);
      }
    }
    return { type: "measure-result", id: req.id, ok: true, entries };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { type: "measure-result", id: req.id, ok: false, error: message };
  }
}

// Worker-scope listener. Guarded so this file is importable in non-worker
// contexts (e.g., type-check passes in apps/web that bundle it, or unit
// tests that exercise `handleMeasureRequest` directly).
if (typeof self !== "undefined" && typeof addEventListener === "function") {
  // SAFETY: `postMessage` exists in worker scope; this file is only
  // wired up via `new Worker(...)` from `measureWorker.ts`. The
  // unicorn `targetOrigin` lint targets `window.postMessage`; the
  // worker variant does not accept that argument.
  const workerScope = self as unknown as {
    postMessage: (m: MeasureWorkerResponse) => void;
  };
  addEventListener("message", (event: MessageEvent<MeasureWorkerRequest>) => {
    const reply = handleMeasureRequest(event.data);
    // eslint-disable-next-line unicorn/require-post-message-target-origin
    workerScope.postMessage(reply);
  });
}
