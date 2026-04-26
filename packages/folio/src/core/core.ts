/**
 * stella/folio — core barrel
 *
 * Core entry point — types, parser, serializer, and utilities.
 * No React or ProseMirror dependencies.
 */

// ============================================================================
// VERSION
// ============================================================================

export const VERSION = "0.0.2";

// ============================================================================
// PARSER / SERIALIZER
// ============================================================================

export { parseDocx } from "./docx/parser";
export {
  serializeDocument as serializeDocx,
  serializeDocumentBody,
  serializeSectionProperties,
} from "./docx/serializer/documentSerializer";
export { repackDocx, createDocx, updateMultipleFiles } from "./docx/rezip";
export { attemptSelectiveSave } from "./docx/selectiveSave";
export {
  buildPatchedDocumentXml,
  validatePatchSafety,
} from "./docx/selectiveXmlPatch";

// ============================================================================
// DOCUMENT CREATION
// ============================================================================

export {
  createEmptyDocument,
  createDocumentWithText,
  type CreateEmptyDocumentOptions,
} from "./utils/createDocument";

// ============================================================================
// UTILITIES
// ============================================================================

export {
  twipsToPixels,
  pixelsToTwips,
  formatPx,
  emuToPixels,
  pointsToPixels,
  halfPointsToPixels,
  pixelsToEmu,
  emuToTwips,
  twipsToEmu,
} from "./utils/units";

export {
  resolveColor,
  resolveHighlightColor,
  resolveShadingColor,
  parseColorString,
  createThemeColor,
  createRgbColor,
  darkenColor,
  lightenColor,
  blendColors,
  getContrastingColor,
  isBlack,
  isWhite,
  colorsEqual,
  generateThemeTintShadeMatrix,
  getThemeTintShadeHex,
  ensureHexPrefix,
  resolveHighlightToCss,
  type ThemeMatrixCell,
} from "./utils/colorResolver";

export {
  createPageBreak,
  createColumnBreak,
  createLineBreak,
  createPageBreakRun,
  createPageBreakParagraph,
  insertPageBreak,
  createHorizontalRule,
  insertHorizontalRule,
  isPageBreak,
  isColumnBreak,
  isLineBreak,
  isBreakContent,
  hasPageBreakBefore,
  countPageBreaks,
  findPageBreaks,
  removePageBreak,
  type InsertPosition,
} from "./utils/insertOperations";

export { type DocxInput, toArrayBuffer } from "./utils/docxInput";

// ============================================================================
// FONT LOADER
// ============================================================================

export {
  loadFont,
  loadFonts,
  loadFontFromBuffer,
  isFontLoaded,
  isLoading as isFontsLoading,
  getLoadedFonts,
  onFontsLoaded,
  canRenderFont,
  preloadCommonFonts,
} from "./utils/fontLoader";

// ============================================================================
// TYPES
// ============================================================================

export type {
  Document,
  DocxPackage,
  DocumentBody,
  BlockContent,
  Paragraph,
  Run,
  RunContent,
  TextContent,
  Table,
  TableRow,
  TableCell,
  Image,
  Shape,
  TextBox,
  Hyperlink,
  BookmarkStart,
  BookmarkEnd,
  Field,
  Theme,
  ThemeColorScheme,
  ThemeFont,
  ThemeFontScheme,
  Style,
  StyleDefinitions,
  TextFormatting,
  ParagraphFormatting,
  SectionProperties,
  HeaderFooter,
  HeaderReference,
  FooterReference,
  Footnote,
  Endnote,
  ListLevel,
  NumberingDefinitions,
  Relationship,
} from "./types/document";

// ============================================================================
// EDITOR PLUGIN API (Framework-Agnostic)
// ============================================================================

export type {
  EditorPluginCore,
  PluginPanelProps,
  PanelConfig,
  RenderedDomContext,
  PositionCoordinates,
} from "./plugin-api/types";

// ============================================================================
// MANAGER CLASSES (Framework-Agnostic Business Logic)
// ============================================================================

export {
  Subscribable,
  AutoSaveManager,
  TableSelectionManager,
  ErrorManager,
  PluginLifecycleManager,
  formatLastSaveTime,
  getAutoSaveStatusLabel,
  getAutoSaveStorageSize,
  formatStorageSize,
  isAutoSaveSupported,
  TABLE_DATA_ATTRIBUTES,
  findTableFromClick,
  getTableFromDocument,
  updateTableInDocument,
  deleteTableFromDocument,
  getSelectionRuns,
  createSelectionFromDOM,
  extractFormattingFromElement,
  rgbToHex,
  injectStyles,
  LayoutCoordinator,
  EditorCoordinator,
} from "./managers";

export type {
  EditorHandle,
  AutoSaveStatus,
  AutoSaveManagerOptions,
  SavedDocumentData,
  AutoSaveSnapshot,
  CellCoordinates,
  TableSelectionSnapshot,
  ErrorSeverity,
  ErrorNotification,
  ErrorManagerSnapshot,
  PluginLifecycleConfig,
  PluginLifecycleSnapshot,
  ClipboardSelection,
  SelectionRect,
  CaretPosition,
  ImageSelectionInfo,
  ColumnResizeState,
  LayoutCoordinatorSnapshot,
  EditorLoadingState,
  EditorCoordinatorOptions,
  EditorCoordinatorSnapshot,
} from "./managers";
