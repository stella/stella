/**
 * Floating exclusion zone unit tests. Mirrors eigenpal #474.
 */

import { describe, expect, test } from "bun:test";

import {
  getFloatingMargins,
  rectsToFloatingZones,
  type FloatingImageZone,
} from "./floatingZones";
import { findClearLineY } from "./measureParagraph";

describe("rectsToFloatingZones", () => {
  test("centered both-sides object falls back to the wider side (split rendering is not yet supported)", () => {
    // Split-segment rendering requires painter support not yet wired
    // through `MeasuredLine`. Until then, a centered both-sides box
    // collapses to the largest single side so text never paints
    // through the excluded region.
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

    expect(zone?.segments).toBeUndefined();
    // leftWidth (200) === rightWidth (200) → tied; largestSideMargins
    // picks the right path, blocking the left side with leftMargin = rectRight.
    expect(zone?.leftMargin).toBe(300);
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

describe("topAndBottom full-width band (eigenpal #694)", () => {
  test("rectsToFloatingZones builds a full-width band, no side wrap", () => {
    const [zone] = rectsToFloatingZones(
      [
        {
          side: "left",
          x: 0,
          y: -10,
          width: 500,
          height: 200,
          distTop: 0,
          distBottom: 0,
          distLeft: 0,
          distRight: 0,
          wrapType: "topAndBottom",
        },
      ],
      500,
    );

    expect(zone?.fullWidthBlock).toBe(true);
    expect(zone?.leftMargin).toBe(0);
    expect(zone?.rightMargin).toBe(0);
    expect(zone?.topY).toBe(-10);
    expect(zone?.bottomY).toBe(190);
  });

  test("getFloatingMargins gives a line overlapping the band zero width", () => {
    const band: FloatingImageZone[] = [
      {
        leftMargin: 0,
        rightMargin: 0,
        topY: 0,
        bottomY: 102,
        fullWidthBlock: true,
      },
    ];
    const margins = getFloatingMargins(10, 16, band, 0);
    expect(margins.segments).toEqual([{ leftOffset: 0, availableWidth: 0 }]);
  });

  test("getFloatingMargins leaves a line clear of the band unobstructed", () => {
    const band: FloatingImageZone[] = [
      {
        leftMargin: 0,
        rightMargin: 0,
        topY: 0,
        bottomY: 102,
        fullWidthBlock: true,
      },
    ];
    expect(getFloatingMargins(120, 16, band, 0)).toEqual({
      leftMargin: 0,
      rightMargin: 0,
    });
  });

  test("findClearLineY pushes a line below the band", () => {
    const band: FloatingImageZone[] = [
      {
        leftMargin: 0,
        rightMargin: 0,
        topY: 0,
        bottomY: 102,
        fullWidthBlock: true,
      },
    ];
    // No text fits in the band → the line hops to its bottom.
    expect(findClearLineY(0, 16, band, 500, 24)).toBe(102);
    // Below the band there is full width again.
    expect(findClearLineY(110, 16, band, 500, 24)).toBe(110);
  });
});
