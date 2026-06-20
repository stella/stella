import { describe, expect, test } from "bun:test";

import { tableInsertButtonOffset } from "./tableInsertButtonGeometry";

describe("tableInsertButtonOffset", () => {
  test("at 100% zoom the offset is the plain screen delta minus the nudge", () => {
    expect(tableInsertButtonOffset(200, 50, 1, 24)).toBe(126);
  });

  test("scales the screen delta down by zoom so the button tracks the table edge (eigenpal/docx-editor#934)", () => {
    // (200-50)/2 = 75 viewport px, then the 24px nudge in button-local space.
    expect(tableInsertButtonOffset(200, 50, 2, 24)).toBe(51);
    // Zoomed out: the delta grows in viewport space.
    expect(tableInsertButtonOffset(200, 50, 0.5, 24)).toBe(276);
  });

  test("treats a zero zoom as 100% instead of dividing by zero", () => {
    expect(tableInsertButtonOffset(200, 50, 0, 24)).toBe(126);
  });
});
