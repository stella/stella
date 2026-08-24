import { describe, expect, test } from "bun:test";

import { isPdfRenderCancellation } from "@/lib/pdf/pdf-renderer.logic";

// Stand-ins for the pdf.js classes: the helper only ever asks `instanceof`,
// and pdf.js's own exceptions are not `Error` subclasses either.
class RenderingCancelledException {
  readonly message = "Rendering cancelled";
}
class AbortException {
  readonly message = "TextLayer task cancelled.";
}
const classes = { RenderingCancelledException, AbortException };

describe("isPdfRenderCancellation", () => {
  test.each([
    ["canvas render task", new RenderingCancelledException()],
    ["text layer task", new AbortException()],
    ["abort signal", new DOMException("aborted", "AbortError")],
  ])("%s cancellation is not a failure", (_label, err) => {
    expect(isPdfRenderCancellation(err, classes)).toBe(true);
  });

  test("a render failure stays a failure", () => {
    expect(
      isPdfRenderCancellation(new Error("Invalid PDF structure"), classes),
    ).toBe(false);
  });

  test("only the abort signal counts before pdf.js has loaded", () => {
    expect(
      isPdfRenderCancellation(new DOMException("aborted", "AbortError"), null),
    ).toBe(true);
    expect(isPdfRenderCancellation(new AbortException(), null)).toBe(false);
  });
});
