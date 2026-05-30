/**
 * Wire format shared between the main-thread proxy
 * (`measureWorker.ts`) and the worker entry
 * (`font-metrics.worker.ts`).
 *
 * The protocol is intentionally minimal: a batched request carrying an
 * array of measurement inputs, and a matching response with widths in
 * the same order. The worker is a pure function — no state, no cache.
 * The main thread owns the LRU cache and is the sole authority on what
 * is worth measuring.
 *
 * Keep this file tiny and dependency-free so it can be imported from
 * both contexts.
 */

/**
 * Single measurement request inside a batch. Mirrors the inputs that
 * `measureTextWidth` already takes on the main thread.
 *
 * `font` is the already-built CSS font string (output of
 * `buildFontString`) so the worker does not need to know about the font
 * resolver or `FontStyle` shape.
 *
 * `horizontalScale` is the multiplier (1.0 = 100 %), so the worker can
 * apply it after the canvas measurement and return the final width.
 */
export type MeasureRequestEntry = {
  text: string;
  font: string;
  letterSpacing: number;
  horizontalScale: number;
};

/**
 * Worker → main response for a single entry. Echoes the input keys the
 * proxy needs in order to look up the right cache slot.
 */
export type MeasureResponseEntry = {
  text: string;
  font: string;
  letterSpacing: number;
  width: number;
};

/**
 * `main → worker` message. `id` lets the proxy reject stale batches if
 * the worker is replaced mid-flight.
 */
export type MeasureWorkerRequest = {
  type: "measure";
  id: number;
  entries: readonly MeasureRequestEntry[];
};

/**
 * `worker → main` message. `ok: false` means the worker hit an
 * unrecoverable error (e.g., no `OffscreenCanvas` after all); the proxy
 * disables itself for the session.
 */
export type MeasureWorkerResponse =
  | {
      type: "measure-result";
      id: number;
      ok: true;
      entries: readonly MeasureResponseEntry[];
    }
  | {
      type: "measure-result";
      id: number;
      ok: false;
      error: string;
    };
