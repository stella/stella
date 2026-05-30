/**
 * Floating exclusion zones — shared between floating images and anchored
 * text boxes. Ported from eigenpal docx-editor #474 to extract per-object
 * zone construction out of the page renderer so text-box anchors can
 * contribute exclusion rects through the same pipeline.
 *
 * Folio adds `clampFloatingWrapMargins` (near-full-width float guard) on top
 * of the upstream conversion; without it, body text after a wide float
 * collapses to ~1 glyph per line.
 */

import { clampFloatingWrapMargins } from "./clampFloatingWrapMargins";

export type WrapTextDirection = "bothSides" | "left" | "right" | "largest";

/**
 * A single floating object's exclusion rectangle in content-area coordinates.
 * Produced from images and anchored text boxes; consumed by
 * `rectsToFloatingZones` to derive per-line wrap margins.
 */
export type FloatingExclusionRect = {
  /** Which side the object is on for simple one-sided wrapping. */
  side: "left" | "right";
  /** X position relative to the content area. */
  x: number;
  /** Y position relative to the content area. */
  y: number;
  width: number;
  height: number;
  distTop: number;
  distBottom: number;
  distLeft: number;
  distRight: number;
  wrapText?: WrapTextDirection;
  wrapType?: string;
};

/**
 * Per-object exclusion zone in the measurement coordinate space. Each rect
 * becomes its own zone so lines at different Y positions get independently
 * correct widths.
 */
export type FloatingImageZone = {
  /** Left margin reduction (pixels from left edge). */
  leftMargin: number;
  /** Right margin reduction (pixels from right edge). */
  rightMargin: number;
  /** Top Y coordinate of the exclusion zone. */
  topY: number;
  /** Bottom Y coordinate of the exclusion zone. */
  bottomY: number;
  /** Optional split segments for centered both-sides wrapping. */
  segments?: FloatingLineSegmentZone[];
};

export type FloatingLineSegmentZone = {
  leftOffset: number;
  availableWidth: number;
};

export type FloatingLineMargins = {
  leftMargin: number;
  rightMargin: number;
  segments?: FloatingLineSegmentZone[];
};

/**
 * Convert floating exclusion rectangles to per-object zones for the
 * measurement system. Mirrors eigenpal #474.
 *
 * `wrapText` controls which side(s) text flows on:
 *   - `right`     → text only on right → object blocks left side (leftMargin)
 *   - `left`      → text only on left  → object blocks right side (rightMargin)
 *   - `bothSides` → split the line into two segments when the object is
 *                   centered in the column; otherwise pick a single side
 *                   based on `rect.side`.
 *   - `largest`   → pick whichever side has more remaining room and reduce
 *                   the line to that single side (no split).
 */
export function rectsToFloatingZones(
  rects: FloatingExclusionRect[],
  contentWidth: number,
): FloatingImageZone[] {
  return rects.map((rect) => {
    const rectLeft = rect.x - rect.distLeft;
    const rectRight = rect.x + rect.width + rect.distRight;
    const rectTop = rect.y - rect.distTop;
    const rectBottom = rect.y + rect.height + rect.distBottom;

    let leftMargin = 0;
    let rightMargin = 0;
    let segments: FloatingLineSegmentZone[] | undefined;

    if (rect.wrapText === "right") {
      leftMargin = leftObjectMargin(rectRight);
    } else if (rect.wrapText === "left") {
      rightMargin = rightObjectMargin(rectLeft, contentWidth);
    } else if (rect.wrapText === "largest") {
      ({ leftMargin, rightMargin } = largestSideMargins(
        rectLeft,
        rectRight,
        contentWidth,
      ));
    } else if (
      rect.wrapText === "bothSides" &&
      canSplitCenteredBothSidesWrap(rectLeft, rectRight, contentWidth)
    ) {
      // Eigenpal #474: a centered both-sides object splits the line into two
      // segments instead of carving a single side. Only applied when the
      // caller explicitly opts in via `wrapText: 'bothSides'` so legacy
      // callers (images relying on `rect.side`-driven single-side wrap) keep
      // their existing behavior.
      segments = centeredWrapSegments(rectLeft, rectRight, contentWidth);
    } else if (rect.side === "left") {
      leftMargin = leftObjectMargin(rectRight);
    } else {
      rightMargin = rightObjectMargin(rectLeft, contentWidth);
    }

    // Near-full-width floats can compute a wrap margin >= contentWidth; if we
    // let that propagate, body text after the float collapses to ~1 glyph per
    // line. Word falls back to full content width in that case.
    const clamped = clampFloatingWrapMargins(
      leftMargin,
      rightMargin,
      contentWidth,
    );

    const zone: FloatingImageZone = {
      leftMargin: clamped.leftMargin,
      rightMargin: clamped.rightMargin,
      topY: rectTop,
      bottomY: rectBottom,
    };
    if (segments) {
      zone.segments = segments;
    }
    return zone;
  });
}

/**
 * Effective horizontal text width for a line under the given margins.
 * Uses the sum of segment widths when the zone provides split segments;
 * otherwise falls back to `baseWidth - leftMargin - rightMargin`.
 */
export function getFloatingAvailableWidth(
  margins: FloatingLineMargins,
  baseWidth: number,
): number {
  const segmentWidth = margins.segments?.reduce(
    (sum, segment) => sum + segment.availableWidth,
    0,
  );
  return segmentWidth ?? baseWidth - margins.leftMargin - margins.rightMargin;
}

/**
 * Calculate width reduction for a line based on floating object zones.
 * Returns the left and right margins (plus optional segments) that apply
 * at this vertical position.
 */
export function getFloatingMargins(
  lineY: number,
  lineHeight: number,
  zones: FloatingImageZone[] | undefined,
  paragraphYOffset: number,
): FloatingLineMargins {
  if (!zones || zones.length === 0) {
    return { leftMargin: 0, rightMargin: 0 };
  }

  let leftMargin = 0;
  let rightMargin = 0;
  let segments: FloatingLineSegmentZone[] | undefined;

  const absoluteLineTop = paragraphYOffset + lineY;
  const absoluteLineBottom = absoluteLineTop + lineHeight;

  for (const zone of zones) {
    if (absoluteLineBottom <= zone.topY || absoluteLineTop >= zone.bottomY) {
      continue;
    }
    if (zone.segments?.length) {
      segments = segments
        ? intersectSegments(segments, zone.segments)
        : zone.segments;
      continue;
    }
    leftMargin = Math.max(leftMargin, zone.leftMargin);
    rightMargin = Math.max(rightMargin, zone.rightMargin);
  }

  if (segments) {
    return { leftMargin, rightMargin, segments };
  }
  return { leftMargin, rightMargin };
}

function intersectSegments(
  a: FloatingLineSegmentZone[],
  b: FloatingLineSegmentZone[],
): FloatingLineSegmentZone[] {
  const result: FloatingLineSegmentZone[] = [];
  for (const left of a) {
    for (const right of b) {
      const start = Math.max(left.leftOffset, right.leftOffset);
      const end = Math.min(
        left.leftOffset + left.availableWidth,
        right.leftOffset + right.availableWidth,
      );
      if (end > start) {
        result.push({ leftOffset: start, availableWidth: end - start });
      }
    }
  }
  return result;
}

function canSplitCenteredBothSidesWrap(
  rectLeft: number,
  rectRight: number,
  contentWidth: number,
): boolean {
  return rectLeft > 0 && rectRight < contentWidth;
}

function centeredWrapSegments(
  rectLeft: number,
  rectRight: number,
  contentWidth: number,
): FloatingLineSegmentZone[] {
  return [
    { leftOffset: 0, availableWidth: Math.max(0, rectLeft) },
    {
      leftOffset: Math.max(0, rectRight),
      availableWidth: Math.max(0, contentWidth - rectRight),
    },
  ].filter((segment) => segment.availableWidth > 1);
}

function largestSideMargins(
  rectLeft: number,
  rectRight: number,
  contentWidth: number,
): Pick<FloatingLineMargins, "leftMargin" | "rightMargin"> {
  const leftWidth = Math.max(0, rectLeft);
  const rightWidth = Math.max(0, contentWidth - rectRight);
  return rightWidth >= leftWidth
    ? { leftMargin: leftObjectMargin(rectRight), rightMargin: 0 }
    : { leftMargin: 0, rightMargin: rightObjectMargin(rectLeft, contentWidth) };
}

function leftObjectMargin(rectRight: number): number {
  return Math.max(0, rectRight);
}

function rightObjectMargin(rectLeft: number, contentWidth: number): number {
  return Math.max(0, contentWidth - rectLeft);
}
