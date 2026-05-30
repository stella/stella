import { describe, expect, test } from "bun:test";

import type { ParagraphBlock } from "../types";
import { measureParagraph } from "./measureParagraph";

// Issue #391/#394 (eigenpal): Word renders an empty paragraph as a single
// readable line — its line height never collapses below 1.15 × font size,
// even when the doc explicitly writes `<w:line w:val="240"/>` (1.0×). The
// floor is scoped to `auto`/`atLeast` line rules; `exact` means exact.

const ARIAL_PT = 11;
const ARIAL_PX = (ARIAL_PT * 96) / 72; // ≈ 14.667

const emptyPara = (
  spacing?: ParagraphBlock["attrs"] extends infer A
    ? A extends { spacing?: infer S }
      ? S
      : never
    : never,
): ParagraphBlock => ({
  kind: "paragraph",
  id: 0,
  runs: [],
  attrs: {
    defaultFontSize: ARIAL_PT,
    defaultFontFamily: "Arial",
    ...(spacing ? { spacing } : {}),
  },
});

describe("empty-paragraph 1.15× line-height floor (eigenpal #391/#394)", () => {
  test("auto rule with line=240 (1.0×) is floored to 1.15× font size", () => {
    const measure = measureParagraph(
      emptyPara({ line: 1, lineUnit: "multiplier", lineRule: "auto" }),
      600,
    );
    const expected = ARIAL_PX * 1.15;
    expect(measure.lines).toHaveLength(1);
    expect(measure.lines[0]!.lineHeight).toBeGreaterThanOrEqual(
      expected - 0.01,
    );
  });

  test("atLeast rule below the floor is also floored", () => {
    const measure = measureParagraph(
      emptyPara({ line: 8, lineUnit: "px", lineRule: "atLeast" }),
      600,
    );
    const expected = ARIAL_PX * 1.15;
    expect(measure.lines[0]!.lineHeight).toBeGreaterThanOrEqual(
      expected - 0.01,
    );
  });

  test("exact rule is NOT floored — exact means exact per OOXML", () => {
    const measure = measureParagraph(
      emptyPara({ line: 8, lineUnit: "px", lineRule: "exact" }),
      600,
    );
    expect(measure.lines[0]!.lineHeight).toBe(8);
  });

  test("auto rule above the floor is unchanged", () => {
    // 2.0× line spacing with Arial's natural metrics is well above the
    // 1.15× floor — the floor must NOT shrink it back to 1.15.
    const measure = measureParagraph(
      emptyPara({ line: 2, lineUnit: "multiplier", lineRule: "auto" }),
      600,
    );
    const floor = ARIAL_PX * 1.15;
    expect(measure.lines[0]!.lineHeight).toBeGreaterThan(floor + 5);
  });
});
