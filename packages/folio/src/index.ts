/**
 * `@stll/folio`
 *
 * A lightweight in-browser WYSIWYG DOCX editor.
 *
 * Features:
 * - Full text and paragraph formatting
 * - Tables, images, shapes, text boxes
 * - Hyperlinks, bookmarks, fields
 * - Footnotes, lists, headers/footers
 * - Page layout with margins and columns
 */

// ============================================================================
// VERSION
// ============================================================================

export const VERSION = "0.0.2";

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export {
  DocxEditor,
  type DocxEditorProps,
  type DocxEditorRef,
  type EditorMode,
} from "./components/DocxEditor";
export { renderAsync } from "./renderAsync";
export { type DocxInput, toArrayBuffer } from "./core/utils/docxInput";

// ============================================================================
// PARSER / SERIALIZER
// ============================================================================

export { parseDocx } from "./core/docx/parser";
export {
  serializeDocument,
  serializeDocumentBody,
  serializeSectionProperties,
} from "./core/docx/serializer/documentSerializer";

// ============================================================================
// DOCUMENT CREATION
// ============================================================================

export {
  createEmptyDocument,
  createDocumentWithText,
  type CreateEmptyDocumentOptions,
} from "./core/utils/createDocument";

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
} from "./core/utils/fontLoader";

// ============================================================================
// UI COMPONENTS
// ============================================================================

export {
  Toolbar,
  type ToolbarProps,
  ToolbarButton,
  ToolbarGroup,
  ToolbarSeparator,
} from "./components/Toolbar";
export {
  FormattingBar,
  type FormattingBarProps,
} from "./components/FormattingBar";
export {
  TextContextMenu,
  type TextContextMenuProps,
  type TextContextAction,
  type TextContextMenuItem,
  type UseTextContextMenuOptions,
  type UseTextContextMenuReturn,
  useTextContextMenu,
  getTextActionLabel,
  getTextActionShortcut,
  getDefaultTextContextMenuItems,
  isTextActionAvailable,
} from "./components/TextContextMenu";

// ============================================================================
// ERROR HANDLING
// ============================================================================

export {
  ErrorBoundary,
  type ErrorBoundaryProps,
  ErrorProvider,
  useErrorNotifications,
  type ErrorContextValue,
  type ErrorNotification,
  type ErrorSeverity,
  ParseErrorDisplay,
  type ParseErrorDisplayProps,
  UnsupportedFeatureWarning,
  type UnsupportedFeatureWarningProps,
  isParseError,
  getUserFriendlyMessage,
} from "./components/ErrorBoundary";

// ============================================================================
// UI CONTROLS
// ============================================================================

export {
  ZoomControl,
  type ZoomControlProps,
} from "./components/ui/ZoomControl";
export {
  FontPicker,
  type FontPickerProps,
  type FontOption,
} from "./components/ui/FontPicker";
export {
  LineSpacingPicker,
  type LineSpacingPickerProps,
  type LineSpacingOption,
} from "./components/ui/LineSpacingPicker";
export {
  StylePicker,
  type StylePickerProps,
  type StyleOption,
} from "./components/ui/StylePicker";
export {
  AlignmentButtons,
  type AlignmentButtonsProps,
} from "./components/ui/AlignmentButtons";
export {
  ListButtons,
  type ListButtonsProps,
  type ListState,
  createDefaultListState,
} from "./components/ui/ListButtons";
export { type TableAction } from "./components/ui/table-types";
export {
  getBuiltinTableStyle,
  type TableStylePreset,
} from "./components/ui/table-styles";

// ============================================================================
// DIALOGS
// ============================================================================

export {
  FindReplaceDialog,
  type FindReplaceDialogProps,
  type FindReplaceOptions,
  type FindOptions,
  type FindMatch,
  type FindResult,
  type FindReplaceState,
  type UseFindReplaceReturn,
  useFindReplace,
  findInDocument,
  findInParagraph,
  findAllMatches,
  scrollToMatch,
  createDefaultFindOptions,
  createSearchPattern,
  replaceAllInContent,
  replaceFirstInContent,
  getMatchCountText,
  isEmptySearch,
  escapeRegexString,
  getDefaultHighlightOptions,
  type HighlightOptions,
} from "./components/dialogs/FindReplaceDialog";
export {
  HyperlinkDialog,
  type HyperlinkDialogProps,
  type HyperlinkData,
  useHyperlinkDialog,
} from "./components/dialogs/HyperlinkDialog";

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
} from "./core/types/document";

// ============================================================================
// HOOKS
// ============================================================================

export {
  useTableSelection,
  TABLE_DATA_ATTRIBUTES,
  type TableSelectionState,
  type UseTableSelectionReturn,
  type UseTableSelectionOptions,
} from "./hooks/useTableSelection";

export {
  useAutoSave,
  formatLastSaveTime,
  getAutoSaveStatusLabel,
  getAutoSaveStorageSize,
  formatStorageSize,
  isAutoSaveSupported,
  type AutoSaveStatus,
  type UseAutoSaveOptions,
  type UseAutoSaveReturn,
  type SavedDocumentData,
} from "./hooks/useAutoSave";

export {
  useWheelZoom,
  getZoomPresets,
  findNearestZoomPreset,
  getNextZoomPreset,
  getPreviousZoomPreset,
  formatZoom,
  parseZoom,
  isZoomPreset,
  clampZoom,
  ZOOM_PRESETS,
  type UseWheelZoomOptions,
  type UseWheelZoomReturn,
} from "./hooks/useWheelZoom";

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
} from "./core/utils/units";
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
} from "./core/utils/colorResolver";
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
} from "./core/utils/insertOperations";

// Internal utilities — consumed by DocxEditor internally, not re-exported.
// Selection, keyboard navigation, clipboard, and plugin API are internal
// implementation details. Import from sub-paths if needed for advanced use.
