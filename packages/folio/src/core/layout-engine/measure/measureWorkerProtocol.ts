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
 *
 * `fontCacheKey` is the main-thread cache identity. It intentionally
 * differs from `font` when scale metadata is appended.
 *
 * `fontFingerprintWidth` is the main-thread width for
 * `WORKER_FONT_FINGERPRINT_TEXT` in the same `font`. The worker checks
 * the same sentinel before measuring and skips entries whose font
 * metrics do not match, which prevents worker fallback fonts from
 * poisoning the main-thread cache.
 */
export type MeasureRequestEntry = {
  text: string;
  font: string;
  fontCacheKey: string;
  fontFingerprintWidth: number;
  letterSpacing: number;
  horizontalScale: number;
};

export const WORKER_FONT_FINGERPRINT_TEXT = "HAMBURGEFONTS ivwqy 0123456789";

/**
 * Count whole code points (not UTF-16 units) so letter spacing is applied once
 * per rendered glyph — an astral character is one glyph spanning two units.
 * Shared by the main thread (`measureContainer`) and the worker so their cached
 * widths agree on astral text with letter spacing. Allocation-free.
 */
export function countCodePoints(text: string): number {
  let count = 0;
  let i = 0;
  while (i < text.length) {
    const code = text.codePointAt(i);
    i += code !== undefined && code > 0xff_ff ? 2 : 1;
    count += 1;
  }
  return count;
}

/**
 * Worker → main response for a single entry. Echoes the input keys the
 * proxy needs in order to look up the right cache slot.
 */
export type MeasureResponseEntry = {
  text: string;
  fontCacheKey: string;
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
