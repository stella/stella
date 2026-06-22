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

  test("merges an edited line pair into word-level runs", () => {
    const prev = "one\nthe quick brown fox\nthree";
    const next = "one\nthe quick red fox\nthree";
    expect(buildLineDiffSegments(prev, next)).toEqual([
      { kind: "unchanged", text: "one" },
      {
        kind: "changed",
        runs: [
          { kind: "same", text: "the quick " },
          { kind: "del", text: "brown" },
          { kind: "ins", text: "red" },
          { kind: "same", text: " fox" },
        ],
      },
      { kind: "unchanged", text: "three" },
    ]);
  });

  test("changed runs reassemble exactly into the old and new lines", () => {
    const oldLine = "Payment is due within 30 days of the invoice date.";
    const newLine = "Payment is due within 14 days of receipt of the invoice.";
    const segments = buildLineDiffSegments(oldLine, newLine);

    expect(segments).toHaveLength(1);
    const segment = segments.at(0);
    if (segment?.kind !== "changed") {
      throw new Error("Expected a merged changed segment");
    }
    const oldSide = segment.runs
      .filter((run) => run.kind !== "ins")
      .map((run) => run.text)
      .join("");
    const newSide = segment.runs
      .filter((run) => run.kind !== "del")
      .map((run) => run.text)
      .join("");
    expect(oldSide).toBe(oldLine);
    expect(newSide).toBe(newLine);
  });

  test("zips adjacent removed/added runs by index; leftovers stay plain", () => {
    const prev = "ctx\nalpha one\nbeta two\ngamma three\nctx2";
    const next = "ctx\nalpha 1\nbeta 2\nctx2";

    const segments = buildLineDiffSegments(prev, next);
    const changed = segments.filter((s) => s.kind === "changed");
    expect(changed).toHaveLength(2);
    // The unpaired third removed line survives as a plain removal.
    expect(segments).toContainEqual({ kind: "removed", text: "gamma three" });
    expect(segments.some((s) => s.kind === "added")).toBe(false);
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
    expect(
      segments.some((s) => s.kind !== "changed" && s.text.includes("line 10")),
    ).toBe(false);
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

  test("oversized line pairs skip word diffing and stay clamped", () => {
    const oldLine = `start ${"a".repeat(12_000)}`;
    const newLine = `start ${"b".repeat(12_000)}`;

    const segments = buildLineDiffSegments(oldLine, newLine);
    expect(segments.map((s) => s.kind)).toEqual(["removed", "added"]);
    for (const segment of segments) {
      if (segment.kind === "changed") {
        throw new Error("Oversized pairs must not be word-diffed");
      }
      expect(segment.text.length).toBeLessThanOrEqual(10_000 + "\n…".length);
      expect(segment.text.endsWith("\n…")).toBe(true);
    }
  });

  test("caps total response size and ends with a gap marker", () => {
    const prevLines = Array.from({ length: 30 }, (_, i) => `p${i}`);
    const nextLines = Array.from(
      { length: 30 },
      (_, i) => `n${i} ${"x".repeat(4000)}`,
    );
    const segments = buildLineDiffSegments(
      prevLines.join("\n"),
      nextLines.join("\n"),
    );

    let totalChars = 0;
    for (const segment of segments) {
      if (segment.kind === "changed") {
        totalChars += segment.runs.reduce((sum, r) => sum + r.text.length, 0);
        continue;
      }
      totalChars += segment.text.length;
    }
    // One segment may straddle the cap; nothing is pushed after it.
    expect(totalChars).toBeLessThanOrEqual(60_000 + 10_000 + "\n…".length);
    expect(segments.at(-1)).toEqual({ kind: "gap", text: "" });
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

  test("re-expands merged changed pairs into -/+ lines", () => {
    const text = diffSegmentsToText([
      {
        kind: "changed",
        runs: [
          { kind: "same", text: "the " },
          { kind: "del", text: "old" },
          { kind: "ins", text: "new" },
          { kind: "same", text: " clause" },
        ],
      },
    ]);
    expect(text).toBe("- the old clause\n+ the new clause");
  });
});
