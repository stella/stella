/**
 * ProseMirror Node Type Interfaces
 *
 * Type definitions for node attributes used by conversion modules,
 * extensions, and other consumers. NodeSpec definitions have moved
 * to the extension system (extensions/core/ and extensions/nodes/).
 */

import type { FloatingTableProperties, TableLook } from "../../types";
import type {
  ParagraphAlignment,
  ParagraphFormatting,
  ParagraphMarkChange,
  ParagraphPropertyChange,
  FieldType,
  Hyperlink,
  LineSpacingRule,
  ImagePosition,
  ImageWrap,
  BorderSpec,
  ShadingProperties,
  TabStop,
  TextFormatting,
  NumberFormat,
  TableFormatting,
  TableRowFormatting,
  TableCell,
  TableCellFormatting,
  TableWidthType,
  SectionProperties,
  ShapeFill,
  ShapeOutline,
  SdtProperties,
  SdtType,
} from "../../types/document";
import type { SpacingExplicit } from "../../types/formatting";

export type HardBreakAttrs = {
  breakType?: "column";
};

/**
 * Paragraph node attributes - maps to ParagraphFormatting
 */
export type ParagraphAttrs = {
  // Identity
  paraId?: string;
  textId?: string;

  // Alignment
  alignment?: ParagraphAlignment;

  // Spacing (in twips)
  spaceBefore?: number;
  spaceAfter?: number;
  lineSpacing?: number;
  lineSpacingRule?: LineSpacingRule;
  spacingExplicit?: SpacingExplicit;

  // Indentation (in twips)
  indentLeft?: number;
  indentRight?: number;
  indentFirstLine?: number;
  hangingIndent?: boolean;

  // List properties
  numPr?: {
    numId?: number;
    ilvl?: number;
  };
  /** List number format (decimal, lowerRoman, upperRoman, etc.) for CSS counter styling */
  listNumFmt?: NumberFormat;
  /** Whether this is a bullet list */
  listIsBullet?: boolean;
  /** Whether this level uses legal numbering (parent placeholders render decimal). */
  listIsLegal?: boolean;
  /** Computed list marker text (e.g., "1.", "1.1.", "•") */
  listMarker?: string;
  /** Whether the list marker is hidden (w:vanish on numbering level rPr) */
  listMarkerHidden?: boolean;
  /** Marker font family from numbering level rPr */
  listMarkerFontFamily?: string;
  /** Marker font size from numbering level rPr, in points */
  listMarkerFontSize?: number;
  /**
   * `w:suff` (§17.9.25) — what follows the marker before body text.
   * `tab` (default) grows the marker to the next tab stop; `space` adds one
   * space glyph; `nothing` lets body text butt against the marker.
   */
  listMarkerSuffix?: "tab" | "space" | "nothing";
  /** `w:caps` on the numbering level rPr — render marker in upper case. */
  listMarkerAllCaps?: boolean;
  /**
   * Inline LISTNUM count carried by this paragraph. Each advances the
   * counter at `ilvl + 1` so a later sibling at that depth renders the
   * next marker letter.
   */
  listImplicitChildLevelAdvances?: number;
  /**
   * When the marker text contains a TAB separator, this column offset (in
   * twips) is where the slot after the tab should land — used to align an
   * inline LISTNUM "(a)" with the deeper level's marker column.
   */
  listMarkerSecondSlotOffsetTwips?: number;
  /** Number format for each level used by multi-level marker templates. */
  listLevelNumFmts?: NumberFormat[];
  /** Abstract numbering ID shared by numbering instances. */
  listAbstractNumId?: number;
  /** Numbering start override for this numId/level. */
  listStartOverride?: number;

  // Style reference
  styleId?: string;

  // Borders
  borders?: {
    top?: BorderSpec;
    bottom?: BorderSpec;
    left?: BorderSpec;
    right?: BorderSpec;
    between?: BorderSpec;
    bar?: BorderSpec;
  };

  // Background/Shading
  shading?: ShadingProperties;

  // Tab stops
  tabs?: TabStop[];

  // Page break control
  pageBreakBefore?: boolean;
  /** Word's cached rendered-page-break marker; preserved for round-trip only. */
  renderedPageBreakBefore?: boolean;
  keepNext?: boolean;
  keepLines?: boolean;
  /** Contextual spacing — suppress space between same-style paragraphs */
  contextualSpacing?: boolean;

  // Default text formatting for empty paragraphs (persists when navigating away)
  // Maps to OOXML pPr/rPr (paragraph's default run properties)
  defaultTextFormatting?: TextFormatting;

  // Section break type — marks end of a section
  sectionBreakType?: "nextPage" | "continuous" | "oddPage" | "evenPage";

  // Text direction
  bidi?: boolean;

  // Outline level for TOC (0-9)
  outlineLevel?: number;

  // Bookmarks on this paragraph (for TOC anchors, cross-references)
  bookmarks?: { id: number; name: string }[];

  /** Empty `w:hyperlink` elements cannot be represented as text marks.
   *  Preserve their relationship metadata at the paragraph boundary so a
   *  no-edit DOCX round-trip does not silently drop hyperlink elements. */
  _emptyHyperlinks?: {
    /** ProseMirror inline offset where the zero-width hyperlink appeared. */
    offset: number;
    href?: Hyperlink["href"];
    anchor?: Hyperlink["anchor"];
    tooltip?: Hyperlink["tooltip"];
    rId?: Hyperlink["rId"];
  }[];

  /**
   * Run-in heading flag: this paragraph's mark carries
   * `<w:specVanish/>` and the next paragraph should flow inline on
   * the same line (NVCA-style "6.11 Severability" → "The
   * invalidity..." merges). Layout consumes this in toFlowBlocks.
   */
  runInWithNext?: boolean;

  /** Original inline paragraph formatting from DOCX (pre-style-resolution).
   *  Used by fromProseDoc for lossless round-trip serialization. */
  _originalFormatting?: ParagraphFormatting;

  /** Full section properties for paragraphs that end a section.
   *  Used by layout engine for per-section column/page config and round-trip. */
  _sectionProperties?: SectionProperties;

  /** Paragraph-property-change tracking entries (`w:pPrChange`).
   *  Preserved opaquely through ProseMirror — the editor does not surface
   *  them in UI today, but stripping them on every edit would corrupt the
   *  `w:pPrChange` history Word relies on for "show previous formatting"
   *  and for reverting an accepted property change. */
  _propertyChanges?: ParagraphPropertyChange[];

  /** Paragraph-mark insertion / deletion (`<w:pPr><w:rPr><w:ins/>` /
   *  `<w:del/>`). Word emits this when the paragraph break itself was
   *  authored in track-changes mode — pressing Enter mid-paragraph
   *  produces an `ins`, Backspace-at-start / Delete-at-end produce a
   *  `del`. Stored as a discriminated union to mirror folio's
   *  `TrackedChangeWrapperType` model rather than two parallel attrs. */
  pPrMark?: ParagraphMarkChange;
};

/**
 * Image position for floating images (horizontal and vertical positioning)
 */
export type ImagePositionAttrs = {
  horizontal?: {
    relativeTo?: NonNullable<ImagePosition["horizontal"]["relativeTo"]>;
    posOffset?: number; // In EMU
    align?: NonNullable<ImagePosition["horizontal"]["alignment"]>;
  };
  vertical?: {
    relativeTo?: NonNullable<ImagePosition["vertical"]["relativeTo"]>;
    posOffset?: number; // In EMU
    align?: NonNullable<ImagePosition["vertical"]["alignment"]>;
  };
};

/**
 * Image node attributes
 */
export type ImageAttrs = {
  src: string;
  alt?: string;
  title?: string;
  /** Width in pixels (already converted from EMU) */
  width?: number;
  /** Height in pixels (already converted from EMU) */
  height?: number;
  rId?: string;
  /** Wrap type from DOCX: inline, square, tight, through, topAndBottom, behind, inFront */
  wrapType?: ImageWrap["type"];
  /** Display mode for CSS: inline (flows with text), float (left/right float), block (centered) */
  displayMode?: "inline" | "float" | "block";
  /** CSS float direction for floating images */
  cssFloat?: "left" | "right" | "none";
  /** CSS transform string (rotation, flip) */
  transform?: string;
  /**
   * Opacity in [0, 1] from `<a:alphaModFix amt>`. Undefined / 1 means fully
   * opaque (no CSS `opacity` emitted). eigenpal #424.
   */
  opacity?: number;
  /** Distance from text above (pixels) */
  distTop?: number;
  /** Distance from text below (pixels) */
  distBottom?: number;
  /** Distance from text left (pixels) */
  distLeft?: number;
  /** Distance from text right (pixels) */
  distRight?: number;
  /**
   * wp:srcRect crop fractions in [0, 1]. Carried through the editor so a
   * cropped image survives parse → edit → serialize. eigenpal #424
   * (image-crop subset).
   */
  cropTop?: number;
  cropRight?: number;
  cropBottom?: number;
  cropLeft?: number;
  /** Position for floating images (horizontal and vertical alignment) */
  position?: ImagePositionAttrs;
  /** Border width in pixels */
  borderWidth?: number;
  /** Border color as CSS color string */
  borderColor?: string;
  /** Border style (CSS border-style value) */
  borderStyle?: string;
  /** Wrap text setting from DOCX (left, right, bothSides, largest) for round-trip */
  wrapText?: NonNullable<ImageWrap["wrapText"]>;
  /** Hyperlink URL for clickable image */
  hlinkHref?: string;
  /** Original OOXML for opaque/unsupported DOCX drawings. */
  _docxRawXml?: string;
};

/**
 * Field node attributes
 */
export type FieldAttrs = {
  /** Field type: PAGE, NUMPAGES, DATE, MERGEFIELD, etc. */
  fieldType: FieldType;
  /** Full field instruction (e.g. "PAGE \\* MERGEFORMAT") */
  instruction: string;
  /** Current/cached display text */
  displayText: string;
  /** Whether the field came from w:fldSimple or a complex fldChar range */
  fieldKind: "simple" | "complex";
  /** Field is locked */
  fldLock?: boolean;
  /** Field is dirty and should be recalculated by the host application */
  dirty?: boolean;
};

/**
 * Math equation node attributes
 */
export type MathAttrs = {
  /** Whether this is inline OMML or a block equation paragraph */
  display?: "inline" | "block";
  /** Raw OMML XML for round-trip preservation */
  ommlXml: string;
  /** Plain text fallback used by the editor and layout engine */
  plainText?: string;
};

/**
 * Structured document tag node attributes
 */
export type SdtAttrs = {
  /** SDT type */
  sdtType: SdtType;
  /** Alias (friendly name) */
  alias?: string;
  /** Tag (developer identifier) */
  tag?: string;
  /** Lock setting */
  lock?: NonNullable<SdtProperties["lock"]>;
  /** Placeholder text */
  placeholder?: string;
  /** Whether showing placeholder */
  showingPlaceholder?: boolean;
  /** Date format for date controls */
  dateFormat?: string;
  /** Dropdown/combobox list items as JSON string */
  listItems?: string;
  /** Checkbox checked state */
  checked?: boolean;
};

/**
 * Block-level structured document tag node attributes. Mirrors `SdtAttrs`
 * plus an optional numeric `w:id` and the verbatim `w:sdtPr`/`w:sdtEndPr`
 * strings captured by the parser for lossless round-trip.
 */
export type BlockSdtAttrs = {
  sdtType: SdtType;
  alias?: string;
  tag?: string;
  /** Numeric `w:id/@w:val`. */
  id?: number;
  lock?: NonNullable<SdtProperties["lock"]>;
  placeholder?: string;
  showingPlaceholder?: boolean;
  dateFormat?: string;
  /** ISO 8601 bound date value (`w:date@w:fullDate`). */
  dateValueISO?: string;
  /** Dropdown/combobox list items as JSON string. */
  listItems?: string;
  checked?: boolean;
  /** Captured `<w:sdtPr>…</w:sdtPr>` for round-trip replay. */
  rawPropertiesXml?: string;
  /** Captured `<w:sdtEndPr>…</w:sdtEndPr>` for round-trip replay. */
  rawEndPropertiesXml?: string;
};

/**
 * Shape node attributes
 */
export type ShapeAttrs = {
  /** Shape type preset */
  shapeType?: string;
  /** Unique identifier */
  shapeId?: string;
  /** Width in pixels */
  width?: number;
  /** Height in pixels */
  height?: number;
  /** Fill color as CSS color */
  fillColor?: string;
  /** Fill type: none, solid, gradient, pattern, picture */
  fillType?: ShapeFill["type"];
  /** Gradient type: linear, radial, rectangular, path */
  gradientType?: NonNullable<ShapeFill["gradient"]>["type"];
  /** Gradient angle in degrees (for linear) */
  gradientAngle?: number;
  /** Gradient stops as JSON string: [{position, color}] */
  gradientStops?: string;
  /** Outline width in pixels */
  outlineWidth?: number;
  /** Outline color as CSS color */
  outlineColor?: string;
  /** Outline style */
  outlineStyle?: string;
  /** Line cap */
  outlineCap?: NonNullable<ShapeOutline["cap"]>;
  /** Head arrow/end marker */
  outlineHeadEnd?: NonNullable<ShapeOutline["headEnd"]>;
  /** Tail arrow/end marker */
  outlineTailEnd?: NonNullable<ShapeOutline["tailEnd"]>;
  /** CSS transform */
  transform?: string;
  /** Display mode */
  displayMode?: "inline" | "float" | "block";
  /** CSS float */
  cssFloat?: "left" | "right" | "none";
  /** Wrap type */
  wrapType?: ImageWrap["type"];
  /** Wrap text setting from DOCX (left, right, bothSides, largest) for round-trip */
  wrapText?: NonNullable<ImageWrap["wrapText"]>;
  /** Distance from text above (pixels) */
  distTop?: number;
  /** Distance from text below (pixels) */
  distBottom?: number;
  /** Distance from text left (pixels) */
  distLeft?: number;
  /** Distance from text right (pixels) */
  distRight?: number;
  /** Position for floating shapes (horizontal and vertical alignment) */
  position?: ImagePositionAttrs;
  /** Shadow color as CSS color */
  shadowColor?: string;
  /** Shadow blur radius in pixels */
  shadowBlur?: number;
  /** Shadow X offset in pixels */
  shadowOffsetX?: number;
  /** Shadow Y offset in pixels */
  shadowOffsetY?: number;
  /** Glow color as CSS color */
  glowColor?: string;
  /** Glow radius in pixels */
  glowRadius?: number;
};

/**
 * Text box node attributes
 */
export type TextBoxAttrs = {
  /** Width in pixels */
  width?: number;
  /** Height in pixels */
  height?: number;
  /** Unique identifier */
  textBoxId?: string;
  /** Fill color as CSS color */
  fillColor?: string;
  /** Outline width in pixels */
  outlineWidth?: number;
  /** Outline color as CSS color */
  outlineColor?: string;
  /** Outline style */
  outlineStyle?: string;
  /** Internal margin top in pixels */
  marginTop?: number;
  /** Internal margin bottom in pixels */
  marginBottom?: number;
  /** Internal margin left in pixels */
  marginLeft?: number;
  /** Internal margin right in pixels */
  marginRight?: number;
  /** Vertical text alignment */
  verticalAlign?: string;
  /** Display mode */
  displayMode?: "inline" | "float" | "block";
  /** CSS float direction */
  cssFloat?: "left" | "right" | "none";
  /** Wrap type */
  wrapType?: string;
  /** OOXML wrapText direction for anchored text boxes (eigenpal #474). */
  wrapText?: "bothSides" | "left" | "right" | "largest";
  /** Wrap distance from top edge, in pixels (OOXML distT, EMU-converted). */
  distTop?: number;
  /** Wrap distance from bottom edge, in pixels. */
  distBottom?: number;
  /** Wrap distance from left edge, in pixels. */
  distLeft?: number;
  /** Wrap distance from right edge, in pixels. */
  distRight?: number;
  /** Original DOCX placement hint for save-path reconstruction. */
  _docxPlacement?: "standalone" | "inlineWithPrevious";
  /** Original DOCX paragraph group for standalone text-box reconstruction. */
  _docxGroupId?: string;
};

/**
 * Table node attributes
 */
export type TableAttrs = {
  /** Table style ID */
  styleId?: string;
  /** Table width (in twips) */
  width?: number;
  /** Table width type ('auto', 'pct', 'dxa') */
  widthType?: TableWidthType;
  /** Table justification/alignment */
  justification?: "left" | "center" | "right";
  /** Column widths (in twips) from w:tblGrid */
  columnWidths?: number[];
  /** Floating table properties (w:tblpPr) */
  floating?: FloatingTableProperties;
  /** Default cell margins for the table (w:tblCellMar), in twips */
  cellMargins?: {
    top?: number;
    bottom?: number;
    left?: number;
    right?: number;
  };
  /** Table look flags for conditional formatting (w:tblLook) */
  look?: TableLook;
  /** Original table formatting from DOCX for lossless round-trip serialization */
  _originalFormatting?: TableFormatting;
};

/**
 * Table row attributes
 */
export type TableRowAttrs = {
  /** Row height (in twips) */
  height?: number;
  /** Height rule ('auto', 'exact', 'atLeast') */
  heightRule?: NonNullable<TableRowFormatting["heightRule"]>;
  /** Is header row */
  isHeader?: boolean;
  /** Original row formatting from DOCX for lossless round-trip serialization */
  _originalFormatting?: TableRowFormatting;
};

/**
 * Table cell attributes
 */
export type TableCellAttrs = {
  /** Column span */
  colspan: number;
  /** Row span */
  rowspan: number;
  /** Column widths for prosemirror-tables resizing (array of pixel widths) */
  colwidth?: number[] | null;
  /** Cell width (in twips) */
  width?: number;
  /** Cell width type */
  widthType?: TableWidthType;
  /** Vertical alignment */
  verticalAlign?: "top" | "center" | "bottom";
  /** Background color (RGB hex) */
  backgroundColor?: string;
  /** OOXML text direction (e.g. 'tbRl', 'btLr') */
  textDirection?: NonNullable<TableCellFormatting["textDirection"]>;
  /** No text wrapping in cell */
  noWrap?: boolean;
  /** Cell borders — full BorderSpec per side (style, color, size) */
  borders?: {
    top?: BorderSpec;
    bottom?: BorderSpec;
    left?: BorderSpec;
    right?: BorderSpec;
  };
  /** Cell margins/padding in twips per side */
  margins?: { top?: number; bottom?: number; left?: number; right?: number };
  /** Original cell formatting from DOCX for lossless round-trip serialization */
  _originalFormatting?: TableCellFormatting;
  /** Preserve a DOCX vMerge restart even when PM cannot model it as a rowspan. */
  _preserveVMergeRestart?: boolean;
  /** Original DOCX vMerge continuation cells skipped into this PM rowspan. */
  _docxVMergeContinuationCells?: TableCell[];
};
