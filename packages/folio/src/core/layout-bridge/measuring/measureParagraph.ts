/**
 * Paragraph measurement module
 *
 * Measures paragraph blocks and computes line breaking.
 * Converts runs into measured lines with typography metrics.
 */

import type {
  ParagraphBlock,
  ParagraphMeasure,
  MeasuredLine,
  Run,
  TextRun,
  TabRun,
  ImageRun,
  LineBreakRun,
  FieldRun,
  ParagraphSpacing,
} from "../../layout-engine/types";
import { isFloatingImageRun } from "../../layout-painter/renderUtils";
import {
  calculateTabWidth,
  pixelsToTwips,
} from "../../prosemirror/utils/tabCalculator";
import type { TabContext } from "../../prosemirror/utils/tabCalculator";
import { DEFAULT_SINGLE_LINE_RATIO } from "../../utils/fontResolver";
import { inlineImageBoundingBox } from "../../utils/rotationBoundingBox";
import { getListMarkerInlineWidth } from "./listMarkerWidth";
import {
  measureTextWidth,
  measureRun,
  getFontMetrics,
  ptToPx,
} from "./measureContainer";
import type { FontStyle, FontMetrics } from "./measureContainer";

// Default values - match OOXML spec defaults
const DEFAULT_FONT_SIZE = 11; // 11pt (Word 2007+ default)
const DEFAULT_FONT_FAMILY = "Calibri";
const DEFAULT_LINE_HEIGHT_MULTIPLIER = 1; // OOXML spec default: single spacing (line=240)

// Floating-point tolerance for line breaking (0.5px)
// Prevents premature line breaks due to measurement rounding
const WIDTH_TOLERANCE = 0.5;

/**
 * Find the longest prefix of `text` that fits within `maxWidth` pixels.
 * Returns the number of characters that fit (at least 1 if `forceMin` is true).
 */
function findMaxFittingLength(
  text: string,
  style: FontStyle,
  maxWidth: number,
  forceMin: boolean = false,
): number {
  let lo = 1;
  let hi = text.length;
  let best = 0;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (measureTextWidth(text.slice(0, mid), style) <= maxWidth) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return forceMin && best === 0 ? 1 : best;
}

/**
 * Floating image exclusion zone - describes an area where text cannot flow.
 * Used to calculate reduced line widths for text wrapping around floating images.
 */
export type FloatingImageZone = {
  /** Left margin reduction (pixels from left edge) */
  leftMargin: number;
  /** Right margin reduction (pixels from right edge) */
  rightMargin: number;
  /** Top Y coordinate of the exclusion zone (pixels from paragraph start) */
  topY: number;
  /** Bottom Y coordinate of the exclusion zone (pixels from paragraph start) */
  bottomY: number;
};

/**
 * Options for paragraph measurement
 */
export type MeasureParagraphOptions = {
  /** Floating image exclusion zones that affect line widths */
  floatingZones?: FloatingImageZone[];
  /** Y offset of this paragraph relative to the exclusion zones (default: 0) */
  paragraphYOffset?: number;
};

/**
 * Typography metrics for a line
 */
type LineTypography = {
  ascent: number;
  descent: number;
  lineHeight: number;
};

/**
 * State tracking for line accumulation
 */
type LineState = {
  fromRun: number;
  fromChar: number;
  toRun: number;
  toChar: number;
  width: number;
  maxFontSize: number;
  maxFontMetrics: FontMetrics | null;
  /** Maximum inline image height in pixels (already in px, not points) */
  maxImageHeightPx: number;
  availableWidth: number;
  /** Left offset from floating images (pixels from content left edge) */
  leftOffset: number;
  /** Right offset from floating images (pixels from content right edge) */
  rightOffset: number;
};

/**
 * Extract FontStyle from a run that carries RunFormatting (text, tab, or
 * field). All three share the same formatting shape, so they measure the
 * same way; widening the parameter keeps tab-following measurement
 * (FieldRun page numbers, etc.) consistent with TextRun handling.
 */
function runToFontStyle(run: TextRun | TabRun | FieldRun): FontStyle {
  return {
    fontFamily: run.fontFamily ?? DEFAULT_FONT_FAMILY,
    fontSize: run.fontSize ?? DEFAULT_FONT_SIZE,
    ...(run.bold !== undefined ? { bold: run.bold } : {}),
    ...(run.italic !== undefined ? { italic: run.italic } : {}),
    ...(run.letterSpacing !== undefined
      ? { letterSpacing: run.letterSpacing }
      : {}),
    ...(run.allCaps ? { textTransform: "uppercase" as const } : {}),
    ...(run.smallCaps ? { fontVariant: "small-caps" as const } : {}),
    ...(run.horizontalScale !== undefined
      ? { horizontalScale: run.horizontalScale }
      : {}),
  };
}

/**
 * Calculate typography metrics from font size and spacing settings
 *
 * @param fontSize - Font size in points
 * @param spacing - Paragraph spacing settings
 * @param metrics - Pre-calculated font metrics (in pixels)
 */
function calculateTypographyMetrics(
  fontSize: number,
  spacing?: ParagraphSpacing,
  metrics?: FontMetrics | null,
): LineTypography {
  // Use provided metrics or calculate from font size
  // When calculating from fontSize (points), convert to pixels first
  const fontSizePx = ptToPx(fontSize);
  const ascent = metrics?.ascent ?? fontSizePx * 0.8;
  const descent = metrics?.descent ?? fontSizePx * 0.2;

  // Apply line spacing rules
  //
  // OOXML lineRule="auto" multipliers (w:line in 240ths):
  //   line=240 → 1.0x (single), line=276 → 1.15x (Word default), line=480 → 2.0x
  //
  // The multiplier base is the font's "single line" height per OOXML spec (§17.3.1.33):
  //   singleLine = (usWinAscent + usWinDescent) / unitsPerEm × fontSizePx
  // This ratio is font-specific (1.07–1.27 for common fonts). We use a hardcoded
  // lookup table of OS/2 metrics since Canvas fontBoundingBox is unreliable
  // cross-platform (Mac uses hhea, not usWin) and Google Font substitutes
  // report different metrics than the original fonts.
  const ratio = metrics?.singleLineRatio ?? DEFAULT_SINGLE_LINE_RATIO;
  const singleLineBase = fontSizePx * ratio;

  let lineHeight: number;

  if (spacing?.lineRule === "exact" && spacing.line !== undefined) {
    // Exact: use specified height exactly
    lineHeight = spacing.line;
  } else if (spacing?.lineRule === "atLeast" && spacing.line !== undefined) {
    // At least: use specified height or natural height, whichever is larger
    const defaultHeight = singleLineBase * DEFAULT_LINE_HEIGHT_MULTIPLIER;
    lineHeight = Math.max(spacing.line, defaultHeight);
  } else if (spacing?.line !== undefined && spacing.lineUnit === "multiplier") {
    // Multiplier applied to font's single-line height
    lineHeight = singleLineBase * spacing.line;
  } else if (spacing?.line !== undefined && spacing.lineUnit === "px") {
    // Pixel value
    lineHeight = spacing.line;
  } else {
    // No explicit spacing — OOXML spec default is line=240 (1.0x = single spacing).
    // Documents wanting 1.15x set w:line=276 explicitly in styles, which flows
    // through the multiplier branch above. This fallback is for paragraphs with
    // no style and no direct formatting.
    lineHeight = singleLineBase * DEFAULT_LINE_HEIGHT_MULTIPLIER;
  }

  return { ascent, descent, lineHeight };
}

/**
 * Word's "single line spacing" floor (≈ 1.15×) applied to empty paragraphs
 * with `auto`/`atLeast` line rules. Without this, narrow-metric fonts
 * (Arial Narrow, OS/2 ratio ≈ 1.117) collapse empty rows visibly tighter
 * than Word renders them. See eigenpal #391/#394.
 */
const WORD_SINGLE_LINE_FLOOR = 1.15;

/**
 * Calculate metrics for an empty paragraph.
 *
 * Word renders an empty paragraph as a single readable line — its line
 * height never collapses below 1.15 × font size, even when the doc
 * explicitly writes `<w:line w:val="240"/>` (1.0×). The floor is scoped to
 * `auto`/`atLeast` line rules; `exact` means exact (per OOXML §17.3.1.33)
 * and stays untouched.
 */
function calculateEmptyParagraphMetrics(
  fontSize: number,
  spacing?: ParagraphSpacing,
  fontFamily?: string,
): LineTypography {
  const metrics = getFontMetrics({
    fontSize,
    fontFamily: fontFamily ?? DEFAULT_FONT_FAMILY,
  });
  const result = calculateTypographyMetrics(fontSize, spacing, metrics);

  const lineRule = spacing?.lineRule ?? "auto";
  if (lineRule === "auto" || lineRule === "atLeast") {
    const fontSizePx = ptToPx(fontSize);
    const floor = fontSizePx * WORD_SINGLE_LINE_FLOOR;
    if (result.lineHeight < floor) {
      return { ...result, lineHeight: floor };
    }
  }
  return result;
}

/**
 * Check if a run is a text run
 */
function isTextRun(run: Run): run is TextRun {
  return run.kind === "text";
}

/**
 * Check if a run is a tab run
 */
function isTabRun(run: Run): run is TabRun {
  return run.kind === "tab";
}

/**
 * Check if a run is an image run
 */
function isImageRun(run: Run): run is ImageRun {
  return run.kind === "image";
}

// Local copies of the painter's rotation helpers (eigenpal #424). Kept in
// sync with `renderParagraph.parseRotationDegrees` /
// `rotatedBoundingBox`; will dedupe once PR #518 + PR #521 land.
function parseRotationDegrees(transform: string | undefined): number {
  if (!transform) {
    return 0;
  }
  const match = /rotate\(\s*([-\d.]+)\s*deg\s*\)/u.exec(transform);
  if (!match) {
    return 0;
  }
  const raw = Number.parseFloat(match[1]!);
  if (!Number.isFinite(raw)) {
    return 0;
  }
  return ((raw % 360) + 360) % 360;
}

function rotatedBlockImageHeight(run: ImageRun): number {
  const deg = parseRotationDegrees(run.transform);
  if (deg === 0 || deg === 180) {
    return run.height;
  }
  if (deg === 90 || deg === 270) {
    return run.width;
  }
  const rad = (deg * Math.PI) / 180;
  const sinA = Math.abs(Math.sin(rad));
  const cosA = Math.abs(Math.cos(rad));
  return run.width * sinA + run.height * cosA;
}

/**
 * Check if a run is a line break run
 */
function isLineBreakRun(run: Run): run is LineBreakRun {
  return run.kind === "lineBreak";
}

/**
 * Check if a run is a field run
 */
function isFieldRun(run: Run): run is FieldRun {
  return run.kind === "field";
}

/**
 * Check if text run is empty (only whitespace or no text)
 */
function isEmptyTextRun(run: TextRun): boolean {
  return !run.text || run.text.replace(/\u00a0/gu, " ").trim().length === 0;
}

/**
 * Sum the inline pixel widths of runs after a tab, up to (but not including)
 * the next tab or line break. Measured per-run so widths reserved match what
 * the painter draws even when trailing runs use different fonts/sizes.
 *
 * Floating/anchored images are skipped — the painter lifts them out of the
 * paragraph flow (see `isFloatingImageRun`) and `measureFollowingContentWidth`
 * in the painter already excludes them, so counting their width here would
 * desync measurer and painter on tab advance for paragraphs with a tab
 * preceding a floating image.
 */
function measureInlineWidthAfterTab(runs: Run[], tabIndex: number): number {
  let width = 0;
  for (let i = tabIndex + 1; i < runs.length; i++) {
    const next = runs[i];
    if (!next || isTabRun(next) || isLineBreakRun(next)) {
      break;
    }
    if (isTextRun(next)) {
      width += measureTextWidth(next.text || "", runToFontStyle(next));
    } else if (isFieldRun(next)) {
      width += measureTextWidth(next.fallback || "1", runToFontStyle(next));
    } else if (isImageRun(next) && !isFloatingImageRun(next)) {
      width += next.width || 0;
    }
  }
  return width;
}

/**
 * Width of the inline content preceding the first `.` in the runs that follow
 * a tab, used to anchor `decimal` tab stops. Mirrors `getTextAfterTab` +
 * decimal-prefix measurement in the painter (`renderParagraph.ts`) so the
 * measurer and painter agree on tab advance for decimal stops.
 *
 * Returns 0 when no decimal separator appears before the next tab / line
 * break — `calculateTabWidth` treats that as "no anchor adjustment".
 */
function measureDecimalPrefixWidthAfterTab(
  runs: Run[],
  tabIndex: number,
): number {
  let text = "";
  let firstRun: TextRun | FieldRun | undefined;
  for (let i = tabIndex + 1; i < runs.length; i++) {
    const next = runs[i];
    if (!next || isTabRun(next) || isLineBreakRun(next)) {
      break;
    }
    if (isTextRun(next)) {
      text += next.text || "";
      firstRun ??= next;
    } else if (isFieldRun(next)) {
      text += next.fallback || "1";
      firstRun ??= next;
    }
  }
  const decimalIndex = text.indexOf(".");
  if (decimalIndex === -1 || !firstRun) {
    return 0;
  }
  return measureTextWidth(
    text.slice(0, decimalIndex),
    runToFontStyle(firstRun),
  );
}

/**
 * Find word break points in text
 * Returns array of indices where words end (after space/punctuation)
 */
function findWordBreaks(text: string): number[] {
  const breaks: number[] = [];

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    // Break after space or certain punctuation
    if (char === " " || char === "-" || char === "\t") {
      breaks.push(i + 1);
    }
  }

  return breaks;
}

/**
 * When a float's wrap margins consume the entire content width (or more),
 * there is no horizontal strip beside it for body text. Word renders the
 * following lines at full content width instead of collapsing them to a
 * 1-glyph column. Unchecked margins from near-full-width tables/images can
 * exceed contentWidth and collapse every wrap line to ~1 character.
 *
 * Returned margins are zeroed when either side alone is >= contentWidth or
 * their sum is >= contentWidth. Otherwise the original (non-negative) values
 * pass through unchanged.
 */
export function clampFloatingWrapMargins(
  leftMargin: number,
  rightMargin: number,
  contentWidth: number,
): { leftMargin: number; rightMargin: number } {
  const cw = Math.max(1, contentWidth);
  const lm = Math.max(0, leftMargin);
  const rm = Math.max(0, rightMargin);
  if (lm >= cw || rm >= cw || lm + rm >= cw) {
    return { leftMargin: 0, rightMargin: 0 };
  }
  return { leftMargin: lm, rightMargin: rm };
}

/**
 * Minimum horizontal room a line must offer before we treat it as usable for
 * body text. Below this threshold the line is bumped past obstructing floats
 * via `findClearLineY` instead of being rendered into the unusable sliver.
 * Without this guard, a near-full-width float (e.g. floating table) produces
 * a ~2px segment that collapses every wrap line to one glyph per row.
 */
export const MIN_WRAP_SEGMENT_WIDTH = 24;

/**
 * Find the next vertical position at or below `startY` where the available
 * text width is at least `minWidth`. Used to skip lines past stacked floats
 * when there is no horizontal room for meaningful text at the current Y.
 *
 * Returns `startY` if the current position already has enough room, otherwise
 * the lowest `bottomY` of any zone currently obstructing the line. The caller
 * is expected to re-query margins at the returned Y.
 *
 * Coordinates are absolute (i.e., already include any paragraphYOffset).
 */
export function findClearLineY(
  startY: number,
  lineHeight: number,
  zones: FloatingImageZone[] | undefined,
  contentWidth: number,
  minWidth: number,
): number {
  if (!zones || zones.length === 0) {
    return startY;
  }

  let y = startY;
  // Bounded loop — at most one step per zone the line currently overlaps,
  // plus a safety cushion. Prevents pathological re-entry while keeping the
  // happy path O(zones).
  for (let i = 0; i < zones.length + 2; i++) {
    const margins = getFloatingMargins(y, lineHeight, zones, 0);
    const available = Math.max(
      0,
      contentWidth - margins.leftMargin - margins.rightMargin,
    );
    if (available >= minWidth) {
      return y;
    }

    const lineBottom = y + lineHeight;
    let nextY = Number.POSITIVE_INFINITY;
    for (const zone of zones) {
      // Skip zones we are already past or that lie entirely below this line.
      if (lineBottom <= zone.topY || y >= zone.bottomY) {
        continue;
      }
      if (zone.bottomY > y && zone.bottomY < nextY) {
        nextY = zone.bottomY;
      }
    }
    if (!Number.isFinite(nextY) || nextY <= y) {
      return y;
    }
    y = nextY;
  }
  return y;
}

/**
 * Calculate width reduction for a line based on floating image zones.
 * Returns the left and right margins that need to be applied.
 */
function getFloatingMargins(
  lineY: number,
  lineHeight: number,
  zones: FloatingImageZone[] | undefined,
  paragraphYOffset: number,
): { leftMargin: number; rightMargin: number } {
  if (!zones || zones.length === 0) {
    return { leftMargin: 0, rightMargin: 0 };
  }

  let leftMargin = 0;
  let rightMargin = 0;

  // Line position relative to exclusion zones
  const absoluteLineTop = paragraphYOffset + lineY;
  const absoluteLineBottom = absoluteLineTop + lineHeight;

  for (const zone of zones) {
    // Check if this line overlaps vertically with the exclusion zone
    if (absoluteLineBottom > zone.topY && absoluteLineTop < zone.bottomY) {
      leftMargin = Math.max(leftMargin, zone.leftMargin);
      rightMargin = Math.max(rightMargin, zone.rightMargin);
    }
  }

  return { leftMargin, rightMargin };
}

/**
 * Measure a paragraph block and compute line breaks
 *
 * @param block - The paragraph block to measure
 * @param maxWidth - Maximum available width for the paragraph
 * @param options - Optional measurement options (floating zones, Y offset)
 * @returns ParagraphMeasure with lines and total height
 */
export function measureParagraph(
  block: ParagraphBlock,
  maxWidth: number,
  options?: MeasureParagraphOptions,
): ParagraphMeasure {
  const runs = block.runs;
  const attrs = block.attrs;
  const spacing = attrs?.spacing;

  // Floating image support
  const floatingZones = options?.floatingZones;
  const paragraphYOffset = options?.paragraphYOffset ?? 0;

  // Handle indentation
  const indent = attrs?.indent;
  const indentLeft = indent?.left ?? 0;
  const indentRight = indent?.right ?? 0;
  const firstLineOffset = (indent?.firstLine ?? 0) - (indent?.hanging ?? 0);

  // Calculate base available widths (before floating image adjustment)
  const bodyContentWidth = Math.max(1, maxWidth - indentLeft - indentRight);
  // First line offset: positive = first-line indent (less space), negative = hanging (more space)
  // Subtracting gives correct width in both cases
  let baseFirstLineWidth = Math.max(1, bodyContentWidth - firstLineOffset);

  // List marker on the first line: the marker renders as an inline-block
  // span that's *not* in the run list, so the run-based line breaker
  // doesn't see it. The first line's content area spans from the marker's
  // start to the right margin — for a hanging list that's
  // `bodyContentWidth + hanging` (already widened via `firstLineOffset`);
  // for a first-line indent it's `bodyContentWidth − firstLine`. Subtract
  // the marker's actual painted footprint (`getListMarkerInlineWidth`) so
  // the line breaker sees the same text room the painter leaves.
  //
  // The subtraction is unconditional:
  //
  // - Hanging + `w:suff="tab"` (fitting): markerInlineWidth = hanging, so
  //   the subtraction exactly cancels the `+ hanging` widening and the
  //   text budget reduces to bodyContentWidth (matches body wrap).
  // - Hanging + tab overflow: markerInlineWidth > hanging, subtracting
  //   yields bodyContentWidth − overflow (text budget shrinks past the
  //   body wrap column, matching Word's advance to next tab stop).
  // - Hanging + `w:suff="space"|"nothing"`: markerInlineWidth < hanging,
  //   so the budget is bodyContentWidth + (hanging − markerInlineWidth) —
  //   first line is wider than subsequent lines, matching the painter
  //   which starts body before indentLeft.
  // - First-line indent (no hanging): subtract the full marker width.
  const markerInlineWidth = getListMarkerInlineWidth(block);
  if (markerInlineWidth > 0) {
    baseFirstLineWidth = Math.max(1, baseFirstLineWidth - markerInlineWidth);
  }

  // Track cumulative height for floating zone calculations
  let cumulativeHeight = 0;
  // Vertical space queued for the next line to finalize — set when we hop
  // past a float that leaves no usable horizontal width at the current Y.
  // Cleared each time finalizeLine attaches it to a MeasuredLine.
  let pendingFloatSkip = 0;

  /**
   * If floats leave no usable horizontal room at `cumulativeHeight`, advance
   * past them by mutating cumulativeHeight + pendingFloatSkip.
   */
  const skipObstructingFloats = (
    lineHeight: number,
    lineMaxWidth: number,
  ): void => {
    if (!floatingZones || floatingZones.length === 0) {
      return;
    }
    const absoluteY = paragraphYOffset + cumulativeHeight;
    const clearY = findClearLineY(
      absoluteY,
      lineHeight,
      floatingZones,
      lineMaxWidth,
      MIN_WRAP_SEGMENT_WIDTH,
    );
    const skip = clearY - absoluteY;
    if (skip > 0) {
      cumulativeHeight += skip;
      pendingFloatSkip += skip;
    }
  };

  // Calculate first line width with floating zone adjustment
  // Estimate first line height for floating margin calculation
  const estimatedFirstLineHeight =
    ptToPx(DEFAULT_FONT_SIZE) * DEFAULT_LINE_HEIGHT_MULTIPLIER;
  skipObstructingFloats(estimatedFirstLineHeight, baseFirstLineWidth);
  const firstLineFloatingMargins = getFloatingMargins(
    cumulativeHeight,
    estimatedFirstLineHeight,
    floatingZones,
    paragraphYOffset,
  );
  const firstLineWidth = Math.max(
    1,
    baseFirstLineWidth -
      firstLineFloatingMargins.leftMargin -
      firstLineFloatingMargins.rightMargin,
  );

  const lines: MeasuredLine[] = [];

  // Handle empty paragraph
  if (runs.length === 0) {
    if (attrs?.suppressEmptyParagraphHeight) {
      lines.push({
        fromRun: 0,
        fromChar: 0,
        toRun: 0,
        toChar: 0,
        width: 0,
        ascent: 0,
        descent: 0,
        lineHeight: 0,
      });

      return {
        kind: "paragraph",
        lines,
        totalHeight: 0,
      };
    }

    const emptyFontSize = attrs?.defaultFontSize ?? DEFAULT_FONT_SIZE;
    const emptyFontFamily = attrs?.defaultFontFamily ?? DEFAULT_FONT_FAMILY;
    const emptyMetrics = calculateEmptyParagraphMetrics(
      emptyFontSize,
      spacing,
      emptyFontFamily,
    );
    lines.push({
      fromRun: 0,
      fromChar: 0,
      toRun: 0,
      toChar: 0,
      width: 0,
      ...emptyMetrics,
    });

    let totalHeight = emptyMetrics.lineHeight;
    if (spacing?.before) {
      totalHeight += spacing.before;
    }
    if (spacing?.after) {
      totalHeight += spacing.after;
    }

    return {
      kind: "paragraph",
      lines,
      totalHeight,
    };
  }

  // Check for empty text run only
  if (
    runs.length === 1 &&
    // SAFETY: length === 1 guarantees index 0 exists
    isTextRun(runs[0]!) &&
    isEmptyTextRun(runs[0] as TextRun)
  ) {
    const run = runs[0] as TextRun;
    const fontSize =
      run.fontSize ?? attrs?.defaultFontSize ?? DEFAULT_FONT_SIZE;
    const fontFamily =
      run.fontFamily ?? attrs?.defaultFontFamily ?? DEFAULT_FONT_FAMILY;
    const emptyMetrics = calculateEmptyParagraphMetrics(
      fontSize,
      spacing,
      fontFamily,
    );

    lines.push({
      fromRun: 0,
      fromChar: 0,
      toRun: 0,
      toChar: 0,
      width: 0,
      ...emptyMetrics,
    });

    let totalHeight = emptyMetrics.lineHeight;
    if (spacing?.before) {
      totalHeight += spacing.before;
    }
    if (spacing?.after) {
      totalHeight += spacing.after;
    }

    return {
      kind: "paragraph",
      lines,
      totalHeight,
    };
  }

  // Initialize line state
  let currentLine: LineState = {
    fromRun: 0,
    fromChar: 0,
    toRun: 0,
    toChar: 0,
    width: 0,
    maxFontSize: DEFAULT_FONT_SIZE,
    maxFontMetrics: null,
    maxImageHeightPx: 0,
    availableWidth: firstLineWidth,
    leftOffset: firstLineFloatingMargins.leftMargin,
    rightOffset: firstLineFloatingMargins.rightMargin,
  };

  /**
   * Finalize and push the current line to the lines array
   */
  const finalizeLine = (): void => {
    const typography = calculateTypographyMetrics(
      currentLine.maxFontSize,
      spacing,
      currentLine.maxFontMetrics,
    );

    // If an inline image is taller than the text-based line height, the line
    // grows to fit the image. Word seats an inline image as a tall glyph on
    // the text baseline.
    const finalTypography = { ...typography };
    if (currentLine.maxImageHeightPx > finalTypography.lineHeight) {
      const imageHeight = currentLine.maxImageHeightPx;
      const buffer = finalTypography.descent;
      // `fromRun === toRun` with a tall image present means the line holds
      // exactly that one image (no flowing text/tabs). Must stay paired with
      // the painter's image-only `runsForLine.length === 1 && isImageRun(...)`
      // test in renderLine — the two pick paired line-height + alignment
      // strategies and disagreeing reintroduces the floating-label bug.
      if (currentLine.fromRun === currentLine.toRun) {
        // Image alone on the line: grow to the image height plus the parent
        // font's descent on BOTH sides so the row has visible breathing room
        // above and below the image (Word's render gives a few px of cell
        // padding even with tcMar=0).
        finalTypography.lineHeight = imageHeight + buffer * 2;
        finalTypography.ascent = imageHeight + buffer;
      } else {
        // Image flowing with text/tabs (e.g. a logo + label header line):
        // the full image height sits above the baseline and only the text
        // descent is reserved below — no extra leading above the image. The
        // painter baseline-aligns the row so the image bottom lands on the
        // text baseline.
        finalTypography.lineHeight = imageHeight + buffer;
        finalTypography.ascent = imageHeight;
      }
    }

    const line: MeasuredLine = {
      fromRun: currentLine.fromRun,
      fromChar: currentLine.fromChar,
      toRun: currentLine.toRun,
      toChar: currentLine.toChar,
      width: currentLine.width,
      ...finalTypography,
    };

    // Only add offsets if they're non-zero (for floating images)
    if (currentLine.leftOffset > 0) {
      line.leftOffset = currentLine.leftOffset;
    }
    if (currentLine.rightOffset > 0) {
      line.rightOffset = currentLine.rightOffset;
    }

    // Attach any queued float-skip to this line; the painter reserves it
    // via marginTop and totalHeight already grew by this amount above.
    if (pendingFloatSkip > 0) {
      line.floatSkipBefore = pendingFloatSkip;
      pendingFloatSkip = 0;
    }

    lines.push(line);

    // Update cumulative height for next line's floating zone calculation
    cumulativeHeight += finalTypography.lineHeight;
  };

  /**
   * Start a new line after the current one
   */
  const startNewLine = (runIndex: number, charIndex: number): void => {
    finalizeLine();

    // Calculate available width for new line based on floating zones
    // Estimate the new line's height for overlap calculation
    const estimatedLineHeight =
      ptToPx(DEFAULT_FONT_SIZE) * DEFAULT_LINE_HEIGHT_MULTIPLIER;
    skipObstructingFloats(estimatedLineHeight, bodyContentWidth);
    const floatingMargins = getFloatingMargins(
      cumulativeHeight,
      estimatedLineHeight,
      floatingZones,
      paragraphYOffset,
    );

    // Body content width minus floating image margins
    const adjustedWidth = Math.max(
      1,
      bodyContentWidth -
        floatingMargins.leftMargin -
        floatingMargins.rightMargin,
    );

    currentLine = {
      fromRun: runIndex,
      fromChar: charIndex,
      toRun: runIndex,
      toChar: charIndex,
      width: 0,
      maxFontSize: DEFAULT_FONT_SIZE,
      maxFontMetrics: null,
      maxImageHeightPx: 0,
      availableWidth: adjustedWidth,
      leftOffset: floatingMargins.leftMargin,
      rightOffset: floatingMargins.rightMargin,
    };
  };

  /**
   * Update max font tracking for the current line
   */
  const updateMaxFont = (style: FontStyle): void => {
    const fontSize = style.fontSize ?? DEFAULT_FONT_SIZE;
    // Update when this is the first run on the line (maxFontMetrics not yet set)
    // or when we find a larger font size. Without the !maxFontMetrics check,
    // lines with only <11pt text would use the 11pt default, inflating line height.
    if (!currentLine.maxFontMetrics || fontSize > currentLine.maxFontSize) {
      currentLine.maxFontSize = fontSize;
      currentLine.maxFontMetrics = getFontMetrics(style);
    }
  };

  // Process each run
  for (let runIndex = 0; runIndex < runs.length; runIndex++) {
    // SAFETY: runIndex is bounded by runs.length
    const run = runs[runIndex]!;

    if (isLineBreakRun(run)) {
      // Force line break
      currentLine.toRun = runIndex;
      currentLine.toChar = 0;
      startNewLine(runIndex + 1, 0);
      continue;
    }

    if (isTabRun(run)) {
      const style = runToFontStyle(run);
      updateMaxFont(style);

      const followingWidth = measureInlineWidthAfterTab(runs, runIndex);
      const decimalPrefixWidth = measureDecimalPrefixWidthAfterTab(
        runs,
        runIndex,
      );

      // Tab width comes from the shared tab-stop model (`calculateTabWidth` —
      // computeTabStops + alignment) that the painter also uses, so measurer
      // and painter agree on line widths. `calculateTabWidth` works in
      // content-area coordinates (tab stops are measured from the
      // content-area left edge), so the indent and any first-line offset are
      // folded in here; the line-wrap math further down stays indent-relative.
      const lineX = currentLine.width + currentLine.leftOffset;
      const isFirstLine = lines.length === 0;
      const contentX = indentLeft + (isFirstLine ? firstLineOffset : 0) + lineX;
      const tabContext: TabContext = {
        ...(attrs?.tabs !== undefined ? { explicitStops: attrs.tabs } : {}),
        leftIndent: pixelsToTwips(indentLeft),
      };
      const tabWidth = calculateTabWidth(contentX, tabContext, {
        followingWidth,
        decimalPrefixWidth,
      }).width;

      if (
        currentLine.width + tabWidth >
        currentLine.availableWidth + WIDTH_TOLERANCE
      ) {
        // Tab doesn't fit, start new line
        startNewLine(runIndex, 0);
        updateMaxFont(style);
      }

      currentLine.width += tabWidth;
      currentLine.toRun = runIndex;
      currentLine.toChar = 1;
      continue;
    }

    if (isImageRun(run)) {
      const wrapType = run.wrapType;
      // Match the painter's `isFloatingImageRun` classification —
      // including `behind` / `inFront` (wrapNone). These images are
      // anchored at absolute coordinates and the painter lifts them
      // out of the paragraph flow, so the measurer must also skip
      // them: otherwise the line reserves the image's inline width
      // and height while the painter renders it as an overlay,
      // leaving phantom gaps in the body text (Codex PR #258 review).
      // Drop the `run.position` precondition too — wrapNone images
      // can be authored without an explicit `<wp:positionH>` and
      // still shouldn't contribute to inline metrics.
      const isFloating =
        run.displayMode === "float" ||
        wrapType === "square" ||
        wrapType === "tight" ||
        wrapType === "through" ||
        wrapType === "behind" ||
        wrapType === "inFront";

      if (isFloating) {
        currentLine.toRun = runIndex;
        currentLine.toChar = 1;
        continue;
      }

      // Handle topAndBottom (block) images - they get their own line
      if (wrapType === "topAndBottom" || run.displayMode === "block") {
        // If current line has content, finish it first
        if (currentLine.width > 0) {
          startNewLine(runIndex, 0);
        }

        // The image gets its own line. For rotated images, reserve the
        // axis-aligned bounding-box height so the painter's bbox wrapper
        // (`renderBlockImage`, eigenpal #424) doesn't overflow the line
        // and bleed into the next paragraph. Non-rotated images keep
        // their intrinsic height. Helpers duplicated from the painter
        // until cross-PR dedupe with #518 lands.
        const imageHeight = rotatedBlockImageHeight(run);
        const distTop = run.distTop ?? 6;
        const distBottom = run.distBottom ?? 6;

        // Update line to contain just this image
        currentLine.toRun = runIndex;
        currentLine.toChar = 1;
        // Use image height plus margins as line height (already in pixels)
        currentLine.maxImageHeightPx = imageHeight + distTop + distBottom;

        // Start a new line after the image for subsequent content
        startNewLine(runIndex + 1, 0);
        continue;
      }

      // Handle inline image. Rotated images occupy their axis-aligned bbox,
      // not the raw `run.width × run.height`; the painter wraps them in a
      // bbox-sized span (eigenpal #424). The measurer must reserve the same
      // dims so line-break and line-height match what gets painted.
      const inlineBbox = inlineImageBoundingBox(run);
      const imageWidth = inlineBbox.width;
      const imageHeight = inlineBbox.height;

      // The image's vertical footprint in the line includes its wp:inline
      // distT/distB wrap distances. These default to 0 for inline images
      // (unlike the block path's synthetic 6px). The painter applies them as
      // top/bottom margins on the <img>, so the run's flex baseline (the
      // margin-box edge) stays consistent with this reserved height.
      const imageFootprintPx =
        imageHeight + (run.distTop ?? 0) + (run.distBottom ?? 0);
      if (imageFootprintPx > currentLine.maxImageHeightPx) {
        currentLine.maxImageHeightPx = imageFootprintPx;
      }

      if (
        currentLine.width + imageWidth >
        currentLine.availableWidth + WIDTH_TOLERANCE
      ) {
        // Image doesn't fit, start new line
        startNewLine(runIndex, 0);
      }

      currentLine.width += imageWidth;
      currentLine.toRun = runIndex;
      currentLine.toChar = 1;
      continue;
    }

    if (isFieldRun(run)) {
      // Measure field using fallback text (actual value substituted at render time)
      const fallback = run.fallback || "1";
      const style: FontStyle = {
        fontFamily: run.fontFamily ?? DEFAULT_FONT_FAMILY,
        fontSize: run.fontSize ?? DEFAULT_FONT_SIZE,
        ...(run.bold !== undefined ? { bold: run.bold } : {}),
        ...(run.italic !== undefined ? { italic: run.italic } : {}),
        ...(run.letterSpacing !== undefined
          ? { letterSpacing: run.letterSpacing }
          : {}),
        ...(run.allCaps ? { textTransform: "uppercase" as const } : {}),
        ...(run.smallCaps ? { fontVariant: "small-caps" as const } : {}),
        ...(run.horizontalScale !== undefined
          ? { horizontalScale: run.horizontalScale }
          : {}),
      };
      updateMaxFont(style);

      const fieldWidth = measureTextWidth(fallback, style);
      if (
        currentLine.width > 0 &&
        currentLine.width + fieldWidth >
          currentLine.availableWidth + WIDTH_TOLERANCE
      ) {
        startNewLine(runIndex, 0);
        updateMaxFont(style);
      }

      currentLine.width += fieldWidth;
      currentLine.toRun = runIndex;
      currentLine.toChar = 1;
      continue;
    }

    if (isTextRun(run)) {
      const textRun = run as TextRun;
      const text = textRun.text;
      const style = runToFontStyle(textRun);

      updateMaxFont(style);

      if (!text || text.length === 0) {
        // Empty text run, just update position
        currentLine.toRun = runIndex;
        currentLine.toChar = 0;
        continue;
      }

      // Find word break points for wrapping
      const wordBreaks = findWordBreaks(text);

      // Process text word by word
      let charIndex = 0;

      while (charIndex < text.length) {
        // Find next word boundary
        let nextBreak = text.length;
        for (const breakPoint of wordBreaks) {
          if (breakPoint > charIndex) {
            nextBreak = breakPoint;
            break;
          }
        }

        // Extract word (includes trailing space if present)
        const word = text.slice(charIndex, nextBreak);
        const wordWidth = measureTextWidth(word, style);

        // If the word itself is longer than a line, hard-break by characters.
        // Use substring measurement (not char-by-char accumulation) to preserve
        // kerning accuracy. Char-by-char accumulation overestimates width by
        // ~1-2px per line due to lost kerning, causing extra wraps in narrow cells.
        if (wordWidth > currentLine.availableWidth + WIDTH_TOLERANCE) {
          // Long word that needs hard-breaking. DON'T start a new line first —
          // fill the remaining space on the current line with as many characters
          // as possible. This prevents wasting a full line when a small run
          // (like "{" at 10pt) precedes a long word (like a variable at 5.5pt).
          let chunkStart = 0;

          while (chunkStart < word.length) {
            const spaceLeft =
              currentLine.availableWidth - currentLine.width + WIDTH_TOLERANCE;
            const remaining = word.slice(chunkStart);
            let bestEnd = findMaxFittingLength(remaining, style, spaceLeft);

            // Nothing fits → start a new line and retry (or force 1 char on empty line)
            if (bestEnd === 0) {
              if (currentLine.width > 0) {
                startNewLine(runIndex, charIndex + chunkStart);
                updateMaxFont(style);
                continue;
              }
              bestEnd = 1;
            }

            const chunkEnd = chunkStart + bestEnd;
            const chunk = word.slice(chunkStart, chunkEnd);
            const chunkWidth = measureTextWidth(chunk, style);

            currentLine.width += chunkWidth;
            currentLine.toRun = runIndex;
            currentLine.toChar = charIndex + chunkEnd;

            chunkStart = chunkEnd;
            if (chunkStart < word.length) {
              startNewLine(runIndex, charIndex + chunkStart);
              updateMaxFont(style);
            }
          }

          charIndex = nextBreak;
          continue;
        }

        // Check if word fits on current line
        if (
          currentLine.width > 0 &&
          currentLine.width + wordWidth >
            currentLine.availableWidth + WIDTH_TOLERANCE
        ) {
          // Word doesn't fit, start new line
          startNewLine(runIndex, charIndex);
          // Re-apply font metrics to the new line (startNewLine resets maxFontSize)
          updateMaxFont(style);
        }

        // Add word to current line
        currentLine.width += wordWidth;
        currentLine.toRun = runIndex;
        currentLine.toChar = nextBreak;

        charIndex = nextBreak;
      }
    }
  }

  // Finalize the last line
  finalizeLine();

  // Calculate total height — include floatSkipBefore from lines bumped past
  // floats so containers stay sized correctly.
  const totalHeight = lines.reduce(
    (sum, line) => sum + line.lineHeight + (line.floatSkipBefore ?? 0),
    0,
  );

  // Add spacing before/after
  let totalWithSpacing = totalHeight;
  if (spacing?.before) {
    totalWithSpacing += spacing.before;
  }
  if (spacing?.after) {
    totalWithSpacing += spacing.after;
  }

  return {
    kind: "paragraph",
    lines,
    totalHeight: totalWithSpacing,
  };
}

/**
 * Measure multiple paragraph blocks
 *
 * @param blocks - Array of paragraph blocks to measure
 * @param maxWidth - Maximum available width
 * @returns Array of ParagraphMeasure results
 */
export function measureParagraphs(
  blocks: ParagraphBlock[],
  maxWidth: number,
): ParagraphMeasure[] {
  return blocks.map((block) => measureParagraph(block, maxWidth));
}

/**
 * Get per-character widths for a text run (for click positioning)
 *
 * @param run - The text run to measure
 * @returns Array of character widths
 */
export function getRunCharWidths(run: TextRun): number[] {
  const style = runToFontStyle(run);
  const result = measureRun(run.text, style);
  return result.charWidths;
}
