import { describe, expect, it } from "bun:test";

import type { AnalysisHeading } from "./types";
import { buildSectionMap } from "./types";

const heading = (
  id: string,
  start: string,
  end: string,
  children: AnalysisHeading[] = [],
): AnalysisHeading => ({
  id,
  label: id,
  category: "reasoning",
  startAnchorId: start,
  endAnchorId: end,
  annotations: [],
  children,
});

const anchors = Array.from({ length: 20 }, (_, i) => `p${i}`);

describe("buildSectionMap — runaway clamp", () => {
  it("does not clamp a heading whose range is nested inside another", () => {
    // Two flat siblings that happen to overlap: A covers the
    // whole decision, B is a legitimate inner section. The
    // runaway detector should clamp A (it swallows B) but
    // leave B alone even though B meets the block-count and
    // coverage thresholds on its own.
    const inner = heading("inner", "p5", "p14"); // 10 blocks, 50% coverage
    const outer = heading("outer", "p0", "p19"); // 20 blocks, 100% coverage
    const tree: AnalysisHeading[] = [outer, inner];

    const map = buildSectionMap(tree, anchors);

    // Outer got clamped — it only maps its start anchor (p0).
    expect(map.get("p0")?.headingId).toBe("outer");
    expect(map.get("p1")?.headingId).not.toBe("outer");

    // Inner is preserved across its full range.
    for (let i = 5; i <= 14; i++) {
      expect(map.get(`p${i}`)?.headingId).toBe("inner");
    }
  });

  it("clamps true runaway ranges that partially overlap siblings", () => {
    // Runaway range that partially overlaps a sibling — not
    // nested under it, genuinely crossing the boundary.
    const a = heading("runaway", "p0", "p18"); // 19 blocks
    const b = heading("b", "p10", "p19"); // partial overlap tail
    const tree: AnalysisHeading[] = [a, b];

    const map = buildSectionMap(tree, anchors);

    // Runaway gets clamped to its start anchor.
    expect(map.get("p0")?.headingId).toBe("runaway");
    expect(map.get("p1")?.headingId).not.toBe("runaway");
  });

  it("respects declared parent-child containment", () => {
    // When a heading's children declare their own ranges, the
    // parent should keep its full span even if it contains a
    // child (containment is expected, not runaway).
    const child = heading("child", "p4", "p9");
    const parent = heading("parent", "p2", "p15", [child]);
    const tree: AnalysisHeading[] = [parent];

    const map = buildSectionMap(tree, anchors);

    expect(map.get("p2")?.headingId).toBe("parent");
    expect(map.get("p15")?.headingId).toBe("parent");
  });
});
