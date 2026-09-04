import { describe, expect, test } from "bun:test";

import {
  KANBAN_BAND_CAPTION_ROW_HEIGHT,
  KANBAN_BAND_CAPTION_ROW_HEIGHT_PX,
  KANBAN_CHROME_ROW_HEIGHT,
  KANBAN_CHROME_ROW_HEIGHT_PX,
} from "./layout-tokens";

/** Tailwind's default spacing step, which every `h-*` utility is a count of. */
const SPACING_STEP_PX = 4;

const heightOf = (utility: string): number => {
  const match = /^h-(?<steps>\d+(?:\.\d+)?)$/u.exec(utility);

  if (!match?.groups) {
    throw new Error(`not a spacing-scale height: ${utility}`);
  }

  return Number(match.groups["steps"]) * SPACING_STEP_PX;
};

// One of each pair draws the row and the other offsets everything pinned
// under it, so the two drifting apart parks a sticky control a few pixels off
// the row above it — visible, and traceable to nothing in particular.
describe("kanban chrome row heights", () => {
  test("state the same height as a class and as a measurement", () => {
    expect(heightOf(KANBAN_CHROME_ROW_HEIGHT)).toBe(
      KANBAN_CHROME_ROW_HEIGHT_PX,
    );
    expect(heightOf(KANBAN_BAND_CAPTION_ROW_HEIGHT)).toBe(
      KANBAN_BAND_CAPTION_ROW_HEIGHT_PX,
    );
  });

  // A band names the columns under it, so its caption sits on their row
  // rather than on a shorter one of its own: a smaller caption read as a note
  // about the header row instead of the group the columns belong to.
  test("put a band's caption on the row its columns are on", () => {
    expect(KANBAN_BAND_CAPTION_ROW_HEIGHT).toBe(KANBAN_CHROME_ROW_HEIGHT);
    expect(KANBAN_BAND_CAPTION_ROW_HEIGHT_PX).toBe(KANBAN_CHROME_ROW_HEIGHT_PX);
  });
});
