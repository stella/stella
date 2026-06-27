/**
 * Layout measurement utilities.
 *
 * Pure measurement helpers shared by the bridge (FlowBlock construction,
 * footnote stack sizing) and the painter (in-render re-measurement when
 * floating exclusion zones change line widths). None of the modules here
 * depend on ProseMirror or the DOM; they read `FlowBlock` / `Run` shapes
 * from `../types` and emit `Measure` / zone descriptors.
 */

export {
  getFontMetrics,
  measureTextWidth,
  measureText,
  measureRun,
  getMeasureProvider,
  setMeasureProvider,
  resetMeasureProvider,
  type MeasureProvider,
} from "./measureProvider";

export {
  buildFontString,
  findCharacterAtX,
  getXForCharacter,
  twipsToPx,
  pxToTwips,
  ptToPx,
  pxToPt,
  halfPtToPx,
  pxToHalfPt,
} from "./measureHelpers";

export type {
  FontStyle,
  FontMetrics,
  TextMeasurement,
  RunMeasurement,
} from "./measureTypes";

export {
  measureParagraph,
  measureParagraphs,
  getRunCharWidths,
  clampFloatingWrapMargins,
  type FloatingImageZone,
  type MeasureParagraphOptions,
} from "./measureParagraph";

export {
  rectsToFloatingZones,
  getFloatingMargins,
  getFloatingAvailableWidth,
  type FloatingExclusionRect,
  type FloatingLineMargins,
  type FloatingLineSegmentZone,
  type WrapTextDirection,
} from "./floatingZones";

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
} from "./cache";

export {
  isWorkerFontMetricsEnabled,
  setFolioMeasurementFlags,
  type FolioMeasurementFeatureFlags,
} from "./featureFlags";
