/**
 * Tests for the worker entry's pure `handleMeasureRequest` function.
 *
 * Bun doesn't provide an `OffscreenCanvas` in test scope, so we stub
 * one with a stable per-character width. This is enough to verify the
 * worker contract: response shape, letterSpacing math, horizontalScale
 * math, and graceful failure when `OffscreenCanvas` is absent.
 *
 * The real `OffscreenCanvas` text-rendering path is covered by the
 * visual / playwright suite, not bun:test.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  __resetWorkerCtxForTests,
  handleMeasureRequest,
} from "./font-metrics.worker";
import type { MeasureWorkerRequest } from "./measureWorkerProtocol";

type CanvasStub = { font: string; measureText(text: string): { width: number } };

const FakeOffscreenCanvas = class {
  constructor(_width: number, _height: number) {}
  getContext(type: string): CanvasStub | null {
    if (type !== "2d") {
      return null;
    }
    return {
      font: "",
      measureText(text: string) {
        return { width: text.length * 6 };
      },
    };
  }
};

beforeEach(() => {
  __resetWorkerCtxForTests();
  (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas =
    FakeOffscreenCanvas;
});

afterEach(() => {
  delete (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas;
  __resetWorkerCtxForTests();
});

function req(
  entries: MeasureWorkerRequest["entries"],
  id = 0,
): MeasureWorkerRequest {
  return { type: "measure", id, entries };
}

describe("handleMeasureRequest", () => {
  test("returns widths from the stubbed OffscreenCanvas", () => {
    const reply = handleMeasureRequest(
      req([
        { text: "hello", font: "11px Arial", letterSpacing: 0, horizontalScale: 1 },
      ]),
    );

    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.entries[0]?.width).toBe("hello".length * 6);
      expect(reply.entries[0]?.text).toBe("hello");
      expect(reply.entries[0]?.letterSpacing).toBe(0);
    }
  });

  test("applies letterSpacing for multi-char text", () => {
    const reply = handleMeasureRequest(
      req([
        { text: "abcd", font: "11px Arial", letterSpacing: 2, horizontalScale: 1 },
      ]),
    );

    // 4 chars * 6 = 24, plus 2 * 3 (between 4 chars) = 30
    expect(reply.ok && reply.entries[0]?.width).toBe(30);
  });

  test("does not apply letterSpacing for single-char text", () => {
    const reply = handleMeasureRequest(
      req([
        { text: "a", font: "11px Arial", letterSpacing: 99, horizontalScale: 1 },
      ]),
    );

    expect(reply.ok && reply.entries[0]?.width).toBe(6);
  });

  test("applies horizontalScale multiplicatively", () => {
    const reply = handleMeasureRequest(
      req([
        { text: "abc", font: "11px Arial", letterSpacing: 0, horizontalScale: 2 },
      ]),
    );

    expect(reply.ok && reply.entries[0]?.width).toBe(36);
  });

  test("returns ok:false when OffscreenCanvas is absent", () => {
    // Wipe the module-scoped ctx the previous test populated, then
    // remove the global. The worker must re-check and report failure.
    __resetWorkerCtxForTests();
    delete (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas;

    const reply = handleMeasureRequest(
      req([
        { text: "x", font: "11px Arial", letterSpacing: 0, horizontalScale: 1 },
      ]),
    );

    expect(reply.ok).toBe(false);
    if (!reply.ok) {
      expect(reply.error).toContain("OffscreenCanvas");
    }
  });

  test("echoes the request id back", () => {
    const reply = handleMeasureRequest(
      req(
        [
          { text: "x", font: "11px Arial", letterSpacing: 0, horizontalScale: 1 },
        ],
        42,
      ),
    );

    expect(reply.id).toBe(42);
  });

  test("processes batches in input order", () => {
    const reply = handleMeasureRequest(
      req([
        { text: "a", font: "11px Arial", letterSpacing: 0, horizontalScale: 1 },
        { text: "bb", font: "11px Arial", letterSpacing: 0, horizontalScale: 1 },
        { text: "ccc", font: "11px Arial", letterSpacing: 0, horizontalScale: 1 },
      ]),
    );

    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.entries.map((e) => e.text)).toEqual(["a", "bb", "ccc"]);
      expect(reply.entries.map((e) => e.width)).toEqual([6, 12, 18]);
    }
  });
});
