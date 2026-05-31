/**
 * Layout measurement — back-compat barrel.
 *
 * The implementation moved to `layout-engine/measure/` so the painter can
 * consume measurement helpers without importing across the layer boundary
 * (the painter is downstream of the engine; it was importing from the
 * bridge before this barrel was introduced). The bridge continues to expose
 * the same names so existing call sites need no change.
 *
 * See `__tests__/layer-boundaries.test.ts` and the `folio-layer-boundaries`
 * lint rule for the enforcement.
 */

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
  twipsToPx,
  pxToTwips,
  ptToPx,
  pxToPt,
  halfPtToPx,
  pxToHalfPt,
  type FontStyle,
  type FontMetrics,
  type TextMeasurement,
  type RunMeasurement,
} from "../../layout-engine/measure/measureContainer";

export {
  measureParagraph,
  measureParagraphs,
  getRunCharWidths,
  clampFloatingWrapMargins,
  type FloatingImageZone,
  type MeasureParagraphOptions,
} from "../../layout-engine/measure/measureParagraph";

export {
  rectsToFloatingZones,
  getFloatingMargins,
  getFloatingAvailableWidth,
  type FloatingExclusionRect,
  type FloatingLineMargins,
  type FloatingLineSegmentZone,
  type WrapTextDirection,
} from "../../layout-engine/measure/floatingZones";

export {
  getCachedTextWidth,
  setCachedTextWidth,
  clearTextWidthCache,
  setTextCacheSize,
  getTextCacheSize,
  getCachedFontMetrics,
  setCachedFontMetrics,
  clearFontMetricsCache,
  setFontCacheSize,
  getFontCacheSize,
  hashParagraphBlock,
  getCachedParagraphMeasure,
  setCachedParagraphMeasure,
  clearParagraphMeasureCache,
  setParagraphCacheSize,
  getParagraphCacheSize,
  clearAllCaches,
  getTotalCacheSize,
} from "../../layout-engine/measure/cache";

// Feature-flag accessors for the measurement subsystem. Host apps
// install the bag before mounting `DocxEditor`; measurement code reads
// it on demand. All flags default OFF, so callers who never set the
// bag see identical behaviour to before any of this code existed.
export {
  isWorkerFontMetricsEnabled,
  setFolioMeasurementFlags,
  type FolioMeasurementFeatureFlags,
} from "../../layout-engine/measure/featureFlags";
