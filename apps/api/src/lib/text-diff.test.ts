import { describe, expect, test } from "bun:test";

import { buildLineDiffSegments, diffSegmentsToText } from "./text-diff";

describe("buildLineDiffSegments", () => {
  test("returns empty array when nothing changed", () => {
    const text = "alpha\nbeta\ngamma";
    expect(buildLineDiffSegments(text, text)).toEqual([]);
  });

  test("diffs against the empty document (first version)", () => {
    expect(buildLineDiffSegments("", "alpha\nbeta")).toEqual([
      { kind: "added", text: "alpha\nbeta" },
    ]);
  });

  test("emits added and removed segments around a change", () => {
    const prev = "one\ntwo\nthree";
    const next = "one\ntwo!\nthree";
    expect(buildLineDiffSegments(prev, next)).toEqual([
      { kind: "unchanged", text: "one" },
      { kind: "removed", text: "two" },
      { kind: "added", text: "two!" },
      { kind: "unchanged", text: "three" },
    ]);
  });

  test("collapses long unchanged runs to context lines with a gap", () => {
    const unchanged = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    const prev = ["start", ...unchanged, "end"].join("\n");
    const next = ["start!", ...unchanged, "end!"].join("\n");

    const segments = buildLineDiffSegments(prev, next);
    const gapCount = segments.filter((s) => s.kind === "gap").length;
    expect(gapCount).toBe(1);
    // Context kept on both sides of the elided run.
    expect(segments).toContainEqual({
      kind: "unchanged",
      text: "line 0\nline 1",
    });
    expect(segments).toContainEqual({
      kind: "unchanged",
      text: "line 18\nline 19",
    });
    // Leading/trailing unchanged runs that border a change survive whole
    // only up to the context window; the elided middle never reappears.
    expect(segments.some((s) => s.text.includes("line 10"))).toBe(false);
  });

  test("keeps leading and trailing unchanged runs trimmed to context", () => {
    const head = Array.from({ length: 10 }, (_, i) => `head ${i}`);
    const prev = [...head, "old"].join("\n");
    const next = [...head, "new"].join("\n");

    const segments = buildLineDiffSegments(prev, next);
    // Leading run only needs trailing context (nothing changes before it).
    expect(segments.at(0)).toEqual({ kind: "gap", text: "" });
    expect(segments.at(1)).toEqual({
      kind: "unchanged",
      text: "head 8\nhead 9",
    });
  });
});

describe("diffSegmentsToText", () => {
  test("renders unified-diff-style prefixes", () => {
    const text = diffSegmentsToText([
      { kind: "unchanged", text: "same" },
      { kind: "removed", text: "old a\nold b" },
      { kind: "added", text: "new" },
      { kind: "gap", text: "" },
    ]);
    expect(text).toBe("  same\n- old a\n- old b\n+ new\n@@");
  });
});
