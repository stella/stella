import { describe, expect, test } from "bun:test";

import { layoutMarginNotes } from "@/components/ai-suggestions/review-margin-notes.logic";
import type { MarginNoteAnchor } from "@/components/ai-suggestions/review-margin-notes.logic";

const anchor = (
  id: string,
  anchorTop: number | null,
  height = 60,
): MarginNoteAnchor => ({ id, anchorTop, height });

const layout = (anchors: readonly MarginNoteAnchor[], viewportHeight = 600) =>
  layoutMarginNotes({ anchors, viewportHeight, gap: 8 });

describe("layoutMarginNotes", () => {
  test("keeps a note beside its clause when nothing collides", () => {
    const { placements } = layout([anchor("a", 40), anchor("b", 300)]);
    expect(placements).toEqual([
      { id: "a", top: 40 },
      { id: "b", top: 300 },
    ]);
  });

  test("pushes the later note down by the minimum gap", () => {
    const { placements } = layout([anchor("a", 40), anchor("b", 60)]);
    expect(placements).toEqual([
      { id: "a", top: 40 },
      // 40 + 60 tall + 8 gap; its own anchor at 60 would have overlapped.
      { id: "b", top: 108 },
    ]);
  });

  test("pushes down, never up: the notes keep document order", () => {
    const { placements } = layout([
      anchor("a", 40),
      anchor("b", 50),
      anchor("c", 55),
    ]);
    expect(placements.map((placement) => placement.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(placements.map((placement) => placement.top)).toEqual([
      40, 108, 176,
    ]);
  });

  test("lays out in document order even when the anchors arrive shuffled", () => {
    const { placements } = layout([anchor("b", 300), anchor("a", 40)]);
    expect(placements.map((placement) => placement.id)).toEqual(["a", "b"]);
  });

  test("counts a clause scrolled past as above, nearest first", () => {
    const { placements, aboveIds } = layout([
      anchor("far", -900),
      anchor("near", -20),
      anchor("visible", 100),
    ]);
    expect(aboveIds).toEqual(["near", "far"]);
    expect(placements.map((placement) => placement.id)).toEqual(["visible"]);
  });

  test("counts a clause below the fold as below, nearest first", () => {
    const { placements, belowIds } = layout([
      anchor("far", 2000),
      anchor("near", 700),
      anchor("visible", 100),
    ]);
    expect(belowIds).toEqual(["near", "far"]);
    expect(placements.map((placement) => placement.id)).toEqual(["visible"]);
  });

  test("a note crowded out of the column reads as below, ahead of the far ones", () => {
    const { placements, belowIds } = layout(
      [anchor("a", 0, 80), anchor("b", 10, 80), anchor("c", 400)],
      140,
    );
    expect(placements).toEqual([{ id: "a", top: 0 }]);
    expect(belowIds).toEqual(["b", "c"]);
  });

  test("an unpainted clause is reported below, after the measured ones", () => {
    const { placements, belowIds } = layout([
      anchor("lazy", null),
      anchor("near", 900),
      anchor("visible", 100),
    ]);
    expect(placements.map((placement) => placement.id)).toEqual(["visible"]);
    expect(belowIds).toEqual(["near", "lazy"]);
  });

  test("no anchors is an empty column, not a crash", () => {
    expect(layout([])).toEqual({
      placements: [],
      aboveIds: [],
      belowIds: [],
    });
  });
});
