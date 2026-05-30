/**
 * Floating exclusion zone unit tests. Mirrors eigenpal #474.
 */

import { describe, expect, test } from "bun:test";

import { rectsToFloatingZones } from "./floatingZones";

describe("rectsToFloatingZones", () => {
  test("splits centered both-sides objects into left and right line segments", () => {
    const [zone] = rectsToFloatingZones(
      [
        {
          side: "left",
          x: 200,
          y: 0,
          width: 100,
          height: 40,
          distTop: 0,
          distBottom: 0,
          distLeft: 0,
          distRight: 0,
          wrapText: "bothSides",
        },
      ],
      500,
    );

    expect(zone?.segments).toEqual([
      { leftOffset: 0, availableWidth: 200 },
      { leftOffset: 300, availableWidth: 200 },
    ]);
    expect(zone?.leftMargin).toBe(0);
    expect(zone?.rightMargin).toBe(0);
  });

  test("keeps largest-side wrapping on a single side instead of splitting the line", () => {
    const [zone] = rectsToFloatingZones(
      [
        {
          side: "left",
          x: 100,
          y: 0,
          width: 100,
          height: 40,
          distTop: 0,
          distBottom: 0,
          distLeft: 0,
          distRight: 0,
          wrapText: "largest",
        },
      ],
      500,
    );

    expect(zone?.segments).toBeUndefined();
    expect(zone?.leftMargin).toBe(200);
    expect(zone?.rightMargin).toBe(0);
  });

  test("wrapText='right' (text only on right) carves a left margin", () => {
    const [zone] = rectsToFloatingZones(
      [
        {
          side: "left",
          x: 0,
          y: 0,
          width: 150,
          height: 40,
          distTop: 0,
          distBottom: 0,
          distLeft: 0,
          distRight: 12,
          wrapText: "right",
        },
      ],
      500,
    );

    expect(zone?.leftMargin).toBe(162);
    expect(zone?.rightMargin).toBe(0);
    expect(zone?.segments).toBeUndefined();
  });

  test("wrapText='left' (text only on left) carves a right margin", () => {
    const [zone] = rectsToFloatingZones(
      [
        {
          side: "right",
          x: 350,
          y: 0,
          width: 150,
          height: 40,
          distTop: 0,
          distBottom: 0,
          distLeft: 12,
          distRight: 0,
          wrapText: "left",
        },
      ],
      500,
    );

    expect(zone?.leftMargin).toBe(0);
    expect(zone?.rightMargin).toBe(162);
  });

  test("omitted wrapText falls back to rect.side (preserves pre-#474 image wrap)", () => {
    const [zone] = rectsToFloatingZones(
      [
        {
          side: "left",
          x: 200,
          y: 0,
          width: 100,
          height: 40,
          distTop: 0,
          distBottom: 0,
          distLeft: 0,
          distRight: 0,
        },
      ],
      500,
    );

    expect(zone?.segments).toBeUndefined();
    expect(zone?.leftMargin).toBe(300);
    expect(zone?.rightMargin).toBe(0);
  });

  test("near-full-width float is clamped so body text does not collapse", () => {
    const [zone] = rectsToFloatingZones(
      [
        {
          side: "left",
          x: 0,
          y: 0,
          width: 500,
          height: 40,
          distTop: 0,
          distBottom: 0,
          distLeft: 0,
          distRight: 0,
          wrapText: "right",
        },
      ],
      500,
    );

    expect(zone?.leftMargin).toBe(0);
    expect(zone?.rightMargin).toBe(0);
  });
});
