import { describe, expect, test } from "bun:test";

import type { AnchoredNote } from "./margin-notes.logic";
import { gutterIsAvailable, placeGutterNotes } from "./margin-notes.logic";

const gutter = { width: 260 };
const collapsed = { width: 0 };

const note = (
  id: string,
  anchorTop: number,
  height = 40,
): AnchoredNote<string> => ({ anchorTop, height, note: id });

const topsOf = (placed: { note: string; top: number }[]) =>
  placed.map(({ note: id, top }) => [id, top]);

describe("gutter availability", () => {
  test("a collapsed gutter is no gutter", () => {
    expect(gutterIsAvailable(collapsed)).toBe(false);
    expect(gutterIsAvailable(gutter)).toBe(true);
  });

  test("notes are not placed when the gutter is collapsed", () => {
    expect(
      placeGutterNotes({
        notes: [note("a", 100), note("b", 400)],
        region: collapsed,
      }),
    ).toEqual([]);
  });
});

describe("placing notes in the gutter", () => {
  test("a note sits beside its own text when nothing crowds it", () => {
    expect(
      topsOf(
        placeGutterNotes({
          notes: [note("a", 120), note("b", 400)],
          region: gutter,
        }),
      ),
    ).toEqual([
      ["a", 120],
      ["b", 400],
    ]);
  });

  test("text beside the layers above the region keeps its note inside it", () => {
    const placed = placeGutterNotes({
      notes: [note("verdict", -260), note("parties", -120)],
      region: gutter,
    });

    expect(placed.every(({ top }) => top >= 0)).toBe(true);
    expect(topsOf(placed)).toEqual([
      ["verdict", 8],
      ["parties", 56],
    ]);
    // The anchor is kept as measured, so the note can still draw a leader
    // back to text that sits higher than the region.
    expect(placed.at(0)?.anchorTop).toBe(-260);
  });

  test("crowded notes move down, never up, and never overlap", () => {
    const placed = placeGutterNotes({
      notes: [note("a", 100, 60), note("b", 120, 60), note("c", 130, 60)],
      region: gutter,
    });

    expect(topsOf(placed)).toEqual([
      ["a", 100],
      ["b", 168],
      ["c", 236],
    ]);
  });

  test("notes are laid out in document order, not in the order handed in", () => {
    const placed = placeGutterNotes({
      notes: [note("composer", 90), note("earlier", 40)],
      region: gutter,
    });

    expect(placed.map(({ note: id }) => id)).toEqual(["earlier", "composer"]);
  });
});
