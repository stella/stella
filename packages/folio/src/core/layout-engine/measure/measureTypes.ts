/**
 * Measurement data shapes.
 *
 * Pure type declarations shared by the provider seam (`measureProvider.ts`),
 * the pure helpers (`measureHelpers.ts`), and the canvas implementation
 * (`measureContainer.ts`). Types only — this module has no runtime and never
 * pulls canvas/DOM into an importer's graph.
 */

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
