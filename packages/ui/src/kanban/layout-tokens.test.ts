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

  test("keep a band's caption line shorter than the rows of chrome", () => {
    expect(KANBAN_BAND_CAPTION_ROW_HEIGHT_PX).toBeLessThan(
      KANBAN_CHROME_ROW_HEIGHT_PX,
    );
  });
});
