/**
 * Text Measurement Module
 *
 * Provides text measurement utilities for the layout engine.
 * Uses Canvas API for accurate, cached measurements.
 */

// Core measurement functions
export {
  getCanvasContext,
  resetCanvasContext,
  buildFontString,
  getFontMetrics,
  measureTextWidth,
  measureText,
  measureRun,
  findCharacterAtX,
  getXForCharacter,
  // Unit conversions
  twipsToPx,
  pxToTwips,
  ptToPx,
  pxToPt,
  halfPtToPx,
  pxToHalfPt,
  // Types
  type FontStyle,
  type FontMetrics,
  type TextMeasurement,
  type RunMeasurement,
} from "./measureContainer";

// Paragraph measurement
export {
  measureParagraph,
  measureParagraphs,
  getRunCharWidths,
  clampFloatingWrapMargins,
  type FloatingImageZone,
  type MeasureParagraphOptions,
} from "./measureParagraph";

// Floating exclusion zones (shared by images and anchored text boxes)
export {
  rectsToFloatingZones,
  getFloatingMargins,
  getFloatingAvailableWidth,
  type FloatingExclusionRect,
  type FloatingLineMargins,
  type FloatingLineSegmentZone,
  type WrapTextDirection,
} from "./floatingZones";

// Caching utilities
export {
  // Text width cache
  getCachedTextWidth,
  setCachedTextWidth,
  clearTextWidthCache,
  setTextCacheSize,
  getTextCacheSize,
  // Font metrics cache
  getCachedFontMetrics,
  setCachedFontMetrics,
  clearFontMetricsCache,
  setFontCacheSize,
  getFontCacheSize,
  // Paragraph measure cache
  hashParagraphBlock,
  getCachedParagraphMeasure,
  setCachedParagraphMeasure,
  clearParagraphMeasureCache,
  setParagraphCacheSize,
  getParagraphCacheSize,
  // Global cache management
  clearAllCaches,
  getTotalCacheSize,
} from "./cache";
