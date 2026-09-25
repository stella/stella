import { describe, expect, test } from "bun:test";

import { EXAMPLE_NOTES, exampleNoteAnchors } from "./example-notes.logic";

const paragraphs = (count: number) =>
  Array.from({ length: count }, (_, index) => `p-${String(index)}`);

describe("example note anchors", () => {
  test.each([1, 2, 3, 4, 5, 17, 240])(
    "a %p-paragraph decision gets one note per slice, in reading order",
    (count) => {
      const anchorIds = paragraphs(count);
      const anchors = exampleNoteAnchors({ anchorIds, seed: "decision" });
      const slices = Math.min(EXAMPLE_NOTES.length, count);

      expect(anchors).toHaveLength(slices);
      expect(new Set(anchors).size).toBe(slices);
      const positions = anchors.map((anchor) => anchorIds.indexOf(anchor));
      for (const [slice, position] of positions.entries()) {
        expect(position).toBeGreaterThanOrEqual(
          Math.floor((count * slice) / slices),
        );
        expect(position).toBeLessThan(
          Math.floor((count * (slice + 1)) / slices),
        );
      }
    },
  );

  test("the same decision places its notes the same way every time", () => {
    const anchorIds = paragraphs(120);

    expect(exampleNoteAnchors({ anchorIds, seed: "a" })).toEqual(
      exampleNoteAnchors({ anchorIds, seed: "a" }),
    );
  });

  test("a decision without paragraphs gets no notes", () => {
    expect(exampleNoteAnchors({ anchorIds: [], seed: "a" })).toEqual([]);
  });
});
