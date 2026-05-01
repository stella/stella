import { describe, expect, test } from "bun:test";

import { resolveCommentCreationRange } from "./commentAnchors";

describe("comment creation anchors", () => {
  test("uses the selected range captured when the comment button was shown", () => {
    expect(
      resolveCommentCreationRange({
        docSize: 100,
        capturedRange: { from: 12, to: 18 },
        currentRange: { from: 18, to: 18 },
        savedRange: { from: 30, to: 40 },
      }),
    ).toEqual({ from: 12, to: 18 });
  });

  test("does not create an anchor for a collapsed cursor", () => {
    expect(
      resolveCommentCreationRange({
        docSize: 100,
        capturedRange: { from: 18, to: 18 },
        currentRange: { from: 18, to: 18 },
        savedRange: null,
      }),
    ).toBeNull();
  });

  test("falls back to the last saved selection when toolbar focus collapsed the current selection", () => {
    expect(
      resolveCommentCreationRange({
        docSize: 100,
        capturedRange: { from: 18, to: 18 },
        currentRange: { from: 18, to: 18 },
        savedRange: { from: 30, to: 36 },
      }),
    ).toEqual({ from: 30, to: 36 });
  });

  test("clamps stale ranges to the current document size", () => {
    expect(
      resolveCommentCreationRange({
        docSize: 20,
        capturedRange: { from: 12, to: 40 },
        currentRange: { from: 12, to: 12 },
        savedRange: null,
      }),
    ).toEqual({ from: 12, to: 20 });
  });
});
