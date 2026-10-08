import { describe, expect, test } from "bun:test";

import {
  classifyViewerError,
  VIEWER_RETRY_DELAYS_MS,
  viewerRetryDelayMs,
} from "@/components/viewer/viewer-recovery.logic";
import { APIError } from "@/lib/errors/api";
import { PDFViewerError } from "@/lib/pdf/pdf-errors";

const named = (name: string, message = name): Error => {
  const error = new Error(message);
  error.name = name;
  return error;
};

const apiError = (status: number, details?: Record<string, unknown>) =>
  new APIError({ status, message: `status ${String(status)}`, details });

describe("classifyViewerError", () => {
  test.each([
    // A deploy removed the chunk or the PDF.js worker script.
    [
      "stale route chunk",
      new TypeError("Failed to fetch dynamically imported module: /a.js"),
      "reload-app",
    ],
    [
      "stale chunk (Firefox)",
      new TypeError("error loading dynamically imported module: /a.js"),
      "reload-app",
    ],
    [
      "stale chunk (Safari)",
      new TypeError("Importing a module script failed."),
      "reload-app",
    ],
    [
      "stale PDF.js worker",
      new Error('Setting up fake worker failed: "Failed to fetch".'),
      "reload-app",
    ],
    [
      "stale worker behind a PDF load failure",
      new PDFViewerError({
        code: "LOAD_FAILED",
        message: "Failed to load PDF",
        cause: new Error("Setting up fake worker failed: x"),
      }),
      "reload-app",
    ],
    // Transient: a fresh URL, worker or connection can succeed.
    ["offline", apiError(0), "retry"],
    ["timeout", apiError(408), "retry"],
    ["rate limited", apiError(429), "retry"],
    ["server error", apiError(503), "retry"],
    [
      "expired storage URL",
      apiError(403, { phase: "response", purpose: "display" }),
      "retry",
    ],
    [
      "missing storage object",
      apiError(404, { phase: "response", purpose: "display" }),
      "retry",
    ],
    [
      "PDF.js worker died mid-load",
      new PDFViewerError({
        code: "LOAD_FAILED",
        message: "Failed to load PDF",
        cause: named("UnknownErrorException", "Worker was terminated"),
      }),
      "retry",
    ],
    [
      "cancelled render",
      new PDFViewerError({ code: "CANCELLED", message: "cancelled" }),
      "retry",
    ],
    ["unknown render error", new Error("boom"), "retry"],
    // Final: the server or the file answered for good.
    ["no display rendition", apiError(400), "final"],
    ["no access", apiError(403), "final"],
    ["deleted file", apiError(404), "final"],
    [
      "corrupt PDF",
      new PDFViewerError({
        code: "LOAD_FAILED",
        message: "Failed to load PDF",
        cause: named("InvalidPDFException", "Invalid PDF structure."),
      }),
      "final",
    ],
    [
      "no renderable pages",
      new PDFViewerError({ code: "NO_RENDERABLE_PAGES", message: "empty" }),
      "final",
    ],
    [
      "password required",
      new PDFViewerError({ code: "PASSWORD_REQUIRED", message: "locked" }),
      "final",
    ],
    [
      "wrong password",
      new PDFViewerError({ code: "INCORRECT_PASSWORD", message: "locked" }),
      "final",
    ],
  ] as const)("%s → %s", (_label, error, expected) => {
    expect(classifyViewerError(error).type).toBe(expected);
  });
});

describe("viewerRetryDelayMs", () => {
  test("backs off over a bounded number of automatic attempts", () => {
    const delays = VIEWER_RETRY_DELAYS_MS.map((_delay, attempt) =>
      viewerRetryDelayMs(attempt),
    );
    expect(delays).toEqual([...VIEWER_RETRY_DELAYS_MS]);
    expect(delays.toSorted((a = 0, b = 0) => a - b)).toEqual(delays);
    expect(viewerRetryDelayMs(VIEWER_RETRY_DELAYS_MS.length)).toBeUndefined();
  });
});
