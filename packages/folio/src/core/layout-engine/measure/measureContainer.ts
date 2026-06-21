/**
 * Measurement container for text layout
 *
 * Uses HTML5 Canvas API to measure text runs and calculate typography metrics.
 * Canvas-based measurement is more accurate and performant than DOM-based approaches.
 *
 * Typography conventions (matching Word behavior):
 * - ascent ≈ fontSize * 0.8 (baseline to top)
 * - descent ≈ fontSize * 0.2 (baseline to bottom)
 * - lineHeight from font metrics (fontBoundingBoxAscent + fontBoundingBoxDescent),
 *   falling back to fontSize * 1.0 (OOXML spec default single spacing)
 */

import { panic } from "better-result";

import { resolveFontFamily } from "../../utils/fontResolver";
import { DOCX_BOLD_FONT_WEIGHT } from "../../utils/fontWeights";
import {
  hasCjk,
  isCjkCodePoint,
  segmentByScript,
} from "../../utils/scriptSegments";
import type { RunFormatting } from "../types";
import {
  getCachedFontMetrics,
  getCachedTextWidth,
  getTextWidthCacheGeneration,
  setCachedFontMetrics,
  setCachedTextWidth,
} from "./cache";
import { canPrefetchMeasurement, prefetchMeasurement } from "./measureWorker";
import {
  countCodePoints,
  WORKER_FONT_FINGERPRINT_TEXT,
} from "./measureWorkerProtocol";

// Constants for OOXML unit conversions
const TWIPS_PER_INCH = 1440;
const PX_PER_INCH = 96; // Standard CSS/DOM DPI
const TWIPS_PER_PX = TWIPS_PER_INCH / PX_PER_INCH; // 15 twips per pixel

// Default typography values
const DEFAULT_FONT_SIZE = 11; // 11pt (Word 2007+ default)
const DEFAULT_FONT_FAMILY = "Calibri";
const DEFAULT_LINE_HEIGHT_MULTIPLIER = 1; // OOXML spec default: single spacing (line=240)
const DEFAULT_ASCENT_RATIO = 0.8;
const DEFAULT_DESCENT_RATIO = 0.2;

/**
 * Font styling properties for measurement
 */
export type FontStyle = {
  fontFamily?: string;
  /**
   * East-Asian font for CJK code points. When set, `measureTextWidth` /
   * `measureRun` measure CJK code points with this font and the rest with
   * `fontFamily`, matching the painter's per-script span split so wrapping
   * and click positioning stay in sync.
   */
  eastAsiaFontFamily?: string;
  fontSize?: number; // in points
  bold?: boolean;
  italic?: boolean;
  letterSpacing?: number; // in pixels
  textTransform?: "uppercase";
  fontVariant?: "small-caps";
  horizontalScale?: number;
};

/**
 * Build a measurement `FontStyle` from a run's formatting. Single source of
 * truth for run → FontStyle so every measurement path (layout line-breaking,
 * click-to-position, selection rects) carries the same fields — notably
 * `eastAsiaFontFamily`, which must reach the measurer for CJK click/selection
 * offsets to match what was wrapped and painted. Callers pass their own family
 * and size fallbacks for runs that declare neither.
 */
export function buildRunFontStyle(
  run: RunFormatting,
  fallbackFontFamily: string,
  fallbackFontSize: number,
): FontStyle {
  return {
    fontFamily: run.fontFamily ?? fallbackFontFamily,
    ...(run.eastAsiaFontFamily !== undefined
      ? { eastAsiaFontFamily: run.eastAsiaFontFamily }
      : {}),
    fontSize: run.fontSize ?? fallbackFontSize,
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
 * Typography metrics for a font
 */
export type FontMetrics = {
  fontSize: number;
  ascent: number;
  descent: number;
  lineHeight: number;
  fontFamily: string;
  /** OS/2 single-line ratio for OOXML line spacing calculation */
  singleLineRatio: number;
};

/**
 * Result of measuring a text string
 */
export type TextMeasurement = {
  width: number;
  height: number;
  ascent: number;
  descent: number;
};

/**
 * Result of measuring a run of text
 */
export type RunMeasurement = {
  width: number;
  charWidths: number[]; // Width of each character for click positioning
  metrics: FontMetrics;
};

// Cached canvas context for text measurement
let canvasContext: CanvasRenderingContext2D | null = null;

const workerFontFingerprintCache = new Map<
  string,
  { generation: number; width: number }
>();

/**
 * Get or create a canvas 2D context for text measurement
 */
export function getCanvasContext(): CanvasRenderingContext2D {
  if (!canvasContext) {
    // Create offscreen canvas
    const canvas =
      typeof document !== "undefined" ? document.createElement("canvas") : null;

    if (!canvas) {
      panic("Canvas not available. Ensure this runs in a DOM environment.");
    }

    canvasContext = canvas.getContext("2d");
    if (!canvasContext) {
      panic("Failed to get 2D context from canvas");
    }
  }

  return canvasContext;
}

/**
 * Reset the canvas context (useful for testing)
 */
export function resetCanvasContext(): void {
  canvasContext = null;
}

function getWorkerFontFingerprintWidth(
  ctx: CanvasRenderingContext2D,
  font: string,
): number {
  const generation = getTextWidthCacheGeneration();
  const cached = workerFontFingerprintCache.get(font);
  if (cached?.generation === generation) {
    return cached.width;
  }

  ctx.font = font;
  const width = ctx.measureText(WORKER_FONT_FINGERPRINT_TEXT).width;
  workerFontFingerprintCache.set(font, { generation, width });
  return width;
}

/** Cached resolved font data (CSS fallback + single-line ratio) */
type ResolvedFontCache = {
  cssFallback: string;
  singleLineRatio: number;
};

/** Cache for resolved font data */
const fontResolvedCache = new Map<string, ResolvedFontCache>();

/**
 * Get the resolved font data for a font family, with caching.
 */
function getResolvedData(fontFamily: string): ResolvedFontCache {
  let cached = fontResolvedCache.get(fontFamily);
  if (cached === undefined) {
    const resolved = resolveFontFamily(fontFamily);
    cached = {
      cssFallback: resolved.cssFallback,
      singleLineRatio: resolved.singleLineRatio,
    };
    fontResolvedCache.set(fontFamily, cached);
  }
  return cached;
}

/**
 * Get the CSS fallback string for a font family, with caching.
 */
function getResolvedFallback(fontFamily: string): string {
  return getResolvedData(fontFamily).cssFallback;
}

/**
 * Build a CSS font string from styling properties
 *
 * Font sizes are in points and need to be converted to pixels for canvas.
 * 1pt = 96/72 px ≈ 1.333px at standard web DPI.
 *
 * Uses the font resolver to get category-appropriate fallback stacks
 * (serif fonts get serif fallbacks, sans-serif get sans-serif, etc.)
 * matching the same stacks used in rendering for consistent measurements.
 *
 * @example
 * buildFontString({ fontFamily: "Arial", fontSize: 12, bold: true })
 * // Returns: "800 16px Arial, Arimo, Helvetica, sans-serif" (12pt = 16px)
 */
export function buildFontString(style: FontStyle): string {
  const parts: string[] = [];

  if (style.italic) {
    parts.push("italic");
  }
  if (style.fontVariant) {
    parts.push(style.fontVariant);
  }
  if (style.bold) {
    parts.push(DOCX_BOLD_FONT_WEIGHT);
  }

  // Convert points to pixels for canvas measurement
  const fontSizePt = style.fontSize ?? DEFAULT_FONT_SIZE;
  const fontSizePx = ptToPx(fontSizePt);
  parts.push(`${fontSizePx}px`);

  // Use the font resolver for category-appropriate fallback stacks
  const fontFamily = style.fontFamily ?? DEFAULT_FONT_FAMILY;
  parts.push(getResolvedFallback(fontFamily));

  return parts.join(" ");
}

/**
 * Get typography metrics for a given font size and family
 *
 * Uses Canvas TextMetrics API when available for precise metrics,
 * falls back to ratio-based approximations.
 */
export function getFontMetrics(style: FontStyle): FontMetrics {
  const fontSize = style.fontSize ?? DEFAULT_FONT_SIZE;
  const fontFamily = style.fontFamily ?? DEFAULT_FONT_FAMILY;
  const bold = style.bold ?? false;
  const italic = style.italic ?? false;
  const fontVariant = style.fontVariant;

  const cached = getCachedFontMetrics(
    fontFamily,
    fontSize,
    bold,
    italic,
    fontVariant,
  );
  if (cached !== undefined) {
    return {
      fontSize,
      ascent: cached.ascent,
      descent: cached.descent,
      lineHeight: cached.lineHeight,
      fontFamily,
      singleLineRatio: cached.singleLineRatio,
    };
  }

  // Convert font size from points to pixels
  const fontSizePx = ptToPx(fontSize);

  // Try to get precise metrics from canvas
  let ascent = fontSizePx * DEFAULT_ASCENT_RATIO;
  let descent = fontSizePx * DEFAULT_DESCENT_RATIO;
  let lineHeight = fontSizePx * DEFAULT_LINE_HEIGHT_MULTIPLIER;

  try {
    const ctx = getCanvasContext();
    ctx.font = buildFontString(style);

    // Measure a standard character to get metrics
    const metrics = ctx.measureText("Hg");

    // Use actual bounding box for ascent/descent (ink bounds for baseline positioning)
    if (
      typeof metrics.actualBoundingBoxAscent === "number" &&
      typeof metrics.actualBoundingBoxDescent === "number"
    ) {
      ascent = metrics.actualBoundingBoxAscent;
      descent = metrics.actualBoundingBoxDescent;
    }

    // Note: We intentionally do NOT use fontBoundingBoxAscent/Descent for lineHeight.
    // When Google Font substitutes are used (e.g., EB Garamond for Garamond),
    // their fontBoundingBox metrics are significantly larger than the original font's
    // OS/2 metrics that Word uses (e.g., EB Garamond 12pt: 21px vs Garamond: 18px).
    // Using fontSize * 1.0 (OOXML spec default) as the base provides correct
    // single-line spacing when no explicit line spacing is specified.
  } catch {
    // Use fallback ratio-based values
  }

  // Ensure line height is never smaller than actual glyph bounds
  lineHeight = Math.max(lineHeight, ascent + descent);

  // Look up OS/2 single-line ratio for OOXML line spacing
  const singleLineRatio = getResolvedData(fontFamily).singleLineRatio;

  const result = {
    fontSize, // Keep in points for reference
    ascent,
    descent,
    lineHeight,
    fontFamily,
    singleLineRatio,
  };
  setCachedFontMetrics(fontFamily, fontSize, bold, italic, result, fontVariant);
  return result;
}

/**
 * Measure the width of a text string with specific styling
 *
 * @param text - The text to measure
 * @param style - Font styling properties
 * @returns Width in pixels
 */
export function measureTextWidth(text: string, style: FontStyle): number {
  if (!text) {
    return 0;
  }
  const measuredText = applyTextTransform(text, style);

  // Letter spacing is left to a single span: CSS letter-spacing does not add a
  // gap across the per-script sibling spans the painter would emit, so a
  // letter-spaced run keeps the base font for CJK too (measurement and painting
  // agree; the EA typeface is the trade-off for that narrow case).
  if (
    style.eastAsiaFontFamily &&
    !style.letterSpacing &&
    hasCjk(measuredText)
  ) {
    return measureMixedScriptWidth(measuredText, style);
  }

  const ctx = getCanvasContext();
  const font = buildFontString(style);
  const letterSpacing = style.letterSpacing ?? 0;
  const horizontalScale = getHorizontalScaleFactor(style);
  const fontCacheKey = `${font}|scale:${horizontalScale}`;
  const cached = getCachedTextWidth(measuredText, fontCacheKey, letterSpacing);
  if (cached !== undefined) {
    return cached;
  }

  ctx.font = font;

  const metrics = ctx.measureText(measuredText);

  // Use advance width for line breaking — this is the standard metric for text flow.
  // Painted width (actualBoundingBox) includes glyph overhang which is visual only
  // and should not affect line breaking decisions.
  let width = metrics.width;

  // Apply letter spacing if specified
  if (letterSpacing) {
    const codePoints = countCodePoints(measuredText);
    if (codePoints > 1) {
      width += letterSpacing * (codePoints - 1);
    }
  }

  const scaledWidth = width * horizontalScale;
  setCachedTextWidth(measuredText, fontCacheKey, letterSpacing, scaledWidth);
  if (!canPrefetchMeasurement()) {
    return scaledWidth;
  }

  const fontFingerprintWidth = getWorkerFontFingerprintWidth(ctx, font);
  // Cache miss just cost a main-thread `measureText`. Ask the worker to
  // pre-warm:
  //   1) this exact entry (helps future re-layouts after font-ready,
  //      page-resize, suggestion-mode toggles)
  //   2) the next few binary-search probe points the line-break loop
  //      is about to make (helps the *current* layout pass — the
  //      worker races the main thread and lands hits ahead of the
  //      probes).
  //
  // No-op when the worker flag is OFF or the host lacks
  // `OffscreenCanvas`/`Worker`. See `measureWorker.ts`.
  prefetchMeasurement(
    measuredText,
    font,
    letterSpacing,
    horizontalScale,
    fontCacheKey,
    fontFingerprintWidth,
  );
  prefetchBinarySearchProbes(
    measuredText,
    font,
    fontCacheKey,
    fontFingerprintWidth,
    letterSpacing,
    horizontalScale,
  );
  return scaledWidth;
}

/**
 * Build a glyph-advance-only style for one script segment: keep the properties
 * that change advance width (family, size, bold/italic, small-caps) and drop
 * letter spacing, horizontal scale, transform, and the EA font so the segment
 * takes the single-font path (no double-counting, no recursion).
 */
function glyphAdvanceStyle(
  style: FontStyle,
  fontFamily: string | undefined,
): FontStyle {
  const result: FontStyle = {};
  if (fontFamily !== undefined) {
    result.fontFamily = fontFamily;
  }
  if (style.fontSize !== undefined) {
    result.fontSize = style.fontSize;
  }
  if (style.bold !== undefined) {
    result.bold = style.bold;
  }
  if (style.italic !== undefined) {
    result.italic = style.italic;
  }
  if (style.fontVariant !== undefined) {
    result.fontVariant = style.fontVariant;
  }
  return result;
}

/**
 * Width of text whose CJK code points use `style.eastAsiaFontFamily` and whose
 * other code points use `style.fontFamily`. Each script segment is measured
 * with its own font (reusing the single-font cache); letter spacing and
 * horizontal scale are applied once over the whole string so the total matches
 * the painter, which renders the same segments as sibling spans.
 */
function measureMixedScriptWidth(
  measuredText: string,
  style: FontStyle,
): number {
  const letterSpacing = style.letterSpacing ?? 0;
  const horizontalScale = getHorizontalScaleFactor(style);

  let glyphWidth = 0;
  for (const segment of segmentByScript(measuredText)) {
    const fontFamily = segment.isCjk
      ? style.eastAsiaFontFamily
      : style.fontFamily;
    glyphWidth += measureTextWidth(
      segment.text,
      glyphAdvanceStyle(style, fontFamily),
    );
  }

  let width = glyphWidth;
  if (letterSpacing) {
    const codePoints = countCodePoints(measuredText);
    if (codePoints > 1) {
      width += letterSpacing * (codePoints - 1);
    }
  }
  return width * horizontalScale;
}

/**
 * Speculatively enqueue the slice lengths that a subsequent
 * `findMaxFittingLength` binary search is likely to probe. We pick the
 * geometric series (full, half, quarter, eighth) which covers the
 * majority of probe points the binary search uses, without flooding
 * the worker for runs that will never trigger a line break.
 *
 * The worker is racing the main thread here: if the main thread asks
 * for slice(0, n/2) before the worker has answered, the cache miss
 * pays the main-thread cost as usual. When the worker wins, that probe
 * lands on a hit.
 */
function prefetchBinarySearchProbes(
  text: string,
  font: string,
  fontCacheKey: string,
  fontFingerprintWidth: number,
  letterSpacing: number,
  horizontalScale: number,
): void {
  if (text.length < 4) {
    return;
  }
  // Skip the full-length entry — we just filled it. Probe the
  // half/quarter/eighth slice lengths.
  for (let denom = 2; denom <= 8; denom *= 2) {
    const len = Math.floor(text.length / denom);
    if (len < 2) {
      break;
    }
    prefetchMeasurement(
      text.slice(0, len),
      font,
      letterSpacing,
      horizontalScale,
      fontCacheKey,
      fontFingerprintWidth,
    );
  }
}

/**
 * Measure text and return full metrics
 */
export function measureText(text: string, style: FontStyle): TextMeasurement {
  const width = measureTextWidth(text, style);
  const metrics = getFontMetrics(style);

  return {
    width,
    height: metrics.ascent + metrics.descent,
    ascent: metrics.ascent,
    descent: metrics.descent,
  };
}

/**
 * Measure a run of text and return per-character widths for click positioning
 *
 * @param text - The text to measure
 * @param style - Font styling properties
 * @returns Run measurement with width and per-character widths
 */
export function measureRun(text: string, style: FontStyle): RunMeasurement {
  const metrics = getFontMetrics(style);

  if (!text) {
    return {
      width: 0,
      charWidths: [],
      metrics,
    };
  }

  const ctx = getCanvasContext();
  const baseFont = buildFontString(style);
  ctx.font = baseFont;
  // CJK code points measure with the EA font (matching the painter); the rest
  // keep the base font. Only built when an EA font is present and the run has no
  // letter spacing (which the painter leaves to a single base-font span), so the
  // common path keeps a single `ctx.font` assignment.
  const eastAsiaFont =
    style.eastAsiaFontFamily !== undefined && !style.letterSpacing
      ? buildFontString({ ...style, fontFamily: style.eastAsiaFontFamily })
      : undefined;

  const letterSpacing = style.letterSpacing ?? 0;
  const scale = getHorizontalScaleFactor(style);
  const charWidths: number[] = [];
  let totalWidth = 0;

  // Measure each character for click positioning. Iterate whole code points so
  // an astral CJK ideograph (a surrogate pair) gets the EA font and a real
  // width; `charWidths` stays one entry per UTF-16 unit (the second unit of an
  // astral pair carries 0) so it keeps aligning with ProseMirror offsets.
  let offset = 0;
  for (const char of text) {
    // SAFETY: for...of over a string yields whole code points.
    const cp = char.codePointAt(0)!;
    const measured = applyTextTransform(char, style);
    if (eastAsiaFont !== undefined) {
      ctx.font = isCjkCodePoint(cp) ? eastAsiaFont : baseFont;
    }
    let charWidth = ctx.measureText(measured).width;

    // Add letter spacing after each code point except the last.
    if (letterSpacing && offset + char.length < text.length) {
      charWidth += letterSpacing;
    }

    charWidth *= scale;
    charWidths.push(charWidth);
    if (char.length === 2) {
      charWidths.push(0);
    }
    totalWidth += charWidth;
    offset += char.length;
  }

  return {
    width: totalWidth,
    charWidths,
    metrics,
  };
}

function applyTextTransform(text: string, style: FontStyle): string {
  if (style.textTransform === "uppercase") {
    return text.toLocaleUpperCase();
  }
  return text;
}

function getHorizontalScaleFactor(style: FontStyle): number {
  return (style.horizontalScale ?? 100) / 100;
}

/**
 * Find the character offset at a given X position within a text run
 *
 * @param x - X position relative to run start
 * @param charWidths - Per-character widths from measureRun
 * @returns Character offset (0-based index)
 */
export function findCharacterAtX(x: number, charWidths: number[]): number {
  if (charWidths.length === 0) {
    return 0;
  }
  if (x <= 0) {
    return 0;
  }

  let accumulatedWidth = 0;

  for (let i = 0; i < charWidths.length; i++) {
    // SAFETY: i < charWidths.length in for loop
    const charWidth = charWidths[i]!;
    const charMidpoint = accumulatedWidth + charWidth / 2;

    // If x is before the midpoint, the cursor is at this character
    if (x <= charMidpoint) {
      return i;
    }

    accumulatedWidth += charWidth;
  }

  // X is past all characters, return position after last character
  return charWidths.length;
}

/**
 * Get the X position of a character offset within a text run
 *
 * @param offset - Character offset (0-based index)
 * @param charWidths - Per-character widths from measureRun
 * @returns X position in pixels
 */
export function getXForCharacter(offset: number, charWidths: number[]): number {
  if (offset <= 0 || charWidths.length === 0) {
    return 0;
  }

  const clampedOffset = Math.min(offset, charWidths.length);
  let x = 0;

  for (let i = 0; i < clampedOffset; i++) {
    // SAFETY: i < clampedOffset <= charWidths.length
    x += charWidths[i]!;
  }

  return x;
}

// Unit conversion utilities

/**
 * Convert twips to pixels
 */
export function twipsToPx(twips: number): number {
  return twips / TWIPS_PER_PX;
}

/**
 * Convert pixels to twips
 */
export function pxToTwips(px: number): number {
  return Math.round(px * TWIPS_PER_PX);
}

/**
 * Convert points to pixels
 */
export function ptToPx(pt: number): number {
  return (pt * PX_PER_INCH) / 72;
}

/**
 * Convert pixels to points
 */
export function pxToPt(px: number): number {
  return (px * 72) / PX_PER_INCH;
}

/**
 * Convert OOXML half-points to pixels
 * OOXML font sizes are in half-points (24 = 12pt)
 */
export function halfPtToPx(halfPt: number): number {
  return ptToPx(halfPt / 2);
}

/**
 * Convert pixels to OOXML half-points
 */
export function pxToHalfPt(px: number): number {
  return pxToPt(px) * 2;
}
