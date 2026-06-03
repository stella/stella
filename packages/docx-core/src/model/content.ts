/**
 * Document Content Model
 *
 * All content-bearing types: runs, hyperlinks, bookmarks, fields,
 * images, shapes, tables, lists, paragraphs, headers/footers,
 * footnotes/endnotes, and sections.
 *
 * These types form a deeply interrelated tree (Paragraph ↔ Table ↔ ShapeTextBody)
 * and are kept together to avoid circular import issues.
 */

import type { ColorValue, ThemeColorSlot, BorderSpec } from "./colors";
import type {
  TextFormatting,
  ParagraphFormatting,
  TableFormatting,
  TableRowFormatting,
  TableCellFormatting,
} from "./formatting";
import type { NumberFormat, ListRendering } from "./lists";

// ============================================================================
// RUN CONTENT TYPES
// ============================================================================

/**
 * Plain text content
 */
export type TextContent = {
  type: "text";
  /** The text string */
  text: string;
  /** Preserve whitespace (xml:space="preserve") */
  preserveSpace?: boolean;
};

/**
 * Tab character
 */
export type TabContent = {
  type: "tab";
};

/**
 * Line break
 */
export type BreakContent = {
  type: "break";
  /** Break type */
  breakType?: "page" | "column" | "textWrapping";
  /** Clear type for text wrapping break */
  clear?: "none" | "left" | "right" | "all";
};

/**
 * Symbol character (special font character)
 */
export type SymbolContent = {
  type: "symbol";
  /** Font name */
  font: string;
  /** Character code */
  char: string;
};

/**
 * Footnote or endnote reference
 */
export type NoteReferenceContent = {
  type: "footnoteRef" | "endnoteRef";
  /** Note ID */
  id: number;
};

/**
 * Field character (begin/separate/end)
 */
export type FieldCharContent = {
  type: "fieldChar";
  /** Field character type */
  charType: "begin" | "separate" | "end";
  /** Field is locked */
  fldLock?: boolean;
  /** Field is dirty (needs update) */
  dirty?: boolean;
  /**
   * Cached display value from a child `<w:numberingChange w:original="…"/>`.
   * Word writes this on the end fldChar of self-numbering fields (LISTNUM,
   * AUTONUM, …) so the static "(a)" / "1." text is recoverable without
   * re-evaluating the field. Used as a fallback `fieldResult` when the
   * field has no `separate` run.
   */
  originalValue?: string;
};

/**
 * Field instruction text
 */
export type InstrTextContent = {
  type: "instrText";
  /** Field instruction */
  text: string;
};

/**
 * Soft hyphen
 */
export type SoftHyphenContent = {
  type: "softHyphen";
};

/**
 * Non-breaking hyphen
 */
export type NoBreakHyphenContent = {
  type: "noBreakHyphen";
};

/**
 * Drawing/image reference
 */
export type DrawingContent = {
  type: "drawing";
  /** Image data */
  image: Image;
  /** Original OOXML for package-preserving round-trips of unsupported drawing markup. */
  rawXml?: string;
};

/**
 * Shape reference
 */
export type ShapeContent = {
  type: "shape";
  /** Shape data */
  shape: Shape;
};

/**
 * All possible run content types
 */
export type RunContent =
  | TextContent
  | TabContent
  | BreakContent
  | SymbolContent
  | NoteReferenceContent
  | FieldCharContent
  | InstrTextContent
  | SoftHyphenContent
  | NoBreakHyphenContent
  | DrawingContent
  | ShapeContent;

// ============================================================================
// RUN (w:r)
// ============================================================================

/**
 * A run is a contiguous region of text with the same formatting
 */
export type Run = {
  type: "run";
  /** Text formatting properties */
  formatting?: TextFormatting;
  /** Run-level tracked property changes (w:rPrChange) */
  propertyChanges?: RunPropertyChange[];
  /** Run content (text, tabs, breaks, etc.) */
  content: RunContent[];
};

// ============================================================================
// HYPERLINKS & BOOKMARKS
// ============================================================================

/**
 * Hyperlink (w:hyperlink)
 */
export type Hyperlink = {
  type: "hyperlink";
  /** Relationship ID for external link */
  rId?: string;
  /** Resolved URL (from relationships) */
  href?: string;
  /** Internal bookmark anchor */
  anchor?: string;
  /** Tooltip text */
  tooltip?: string;
  /** Target frame */
  target?: string;
  /** Link history tracking */
  history?: boolean;
  /** Document location */
  docLocation?: string;
  /** Child runs */
  children: (Run | BookmarkStart | BookmarkEnd)[];
};

/**
 * Bookmark start marker (w:bookmarkStart)
 */
export type BookmarkStart = {
  type: "bookmarkStart";
  /** Bookmark ID */
  id: number;
  /** Bookmark name */
  name: string;
  /** Column index for table bookmarks */
  colFirst?: number;
  colLast?: number;
};

/**
 * Bookmark end marker (w:bookmarkEnd)
 */
export type BookmarkEnd = {
  type: "bookmarkEnd";
  /** Bookmark ID */
  id: number;
};

// ============================================================================
// FIELDS
// ============================================================================

/**
 * Known field types
 */
export type FieldType =
  | "PAGE"
  | "NUMPAGES"
  | "NUMWORDS"
  | "NUMCHARS"
  | "DATE"
  | "TIME"
  | "CREATEDATE"
  | "SAVEDATE"
  | "PRINTDATE"
  | "AUTHOR"
  | "TITLE"
  | "SUBJECT"
  | "KEYWORDS"
  | "COMMENTS"
  | "FILENAME"
  | "FILESIZE"
  | "TEMPLATE"
  | "DOCPROPERTY"
  | "DOCVARIABLE"
  | "REF"
  | "PAGEREF"
  | "NOTEREF"
  | "HYPERLINK"
  | "TOC"
  | "TOA"
  | "INDEX"
  | "SEQ"
  | "STYLEREF"
  | "AUTONUM"
  | "AUTONUMLGL"
  | "AUTONUMOUT"
  | "LISTNUM"
  | "IF"
  | "MERGEFIELD"
  | "NEXT"
  | "NEXTIF"
  | "ASK"
  | "SET"
  | "QUOTE"
  | "INCLUDETEXT"
  | "INCLUDEPICTURE"
  | "SYMBOL"
  | "ADVANCE"
  | "EDITTIME"
  | "REVNUM"
  | "SECTION"
  | "SECTIONPAGES"
  | "USERADDRESS"
  | "USERNAME"
  | "USERINITIALS"
  | "UNKNOWN";

/**
 * Simple field (w:fldSimple)
 */
export type SimpleField = {
  type: "simpleField";
  /** Field instruction (e.g., "PAGE \\* MERGEFORMAT") */
  instruction: string;
  /** Parsed field type */
  fieldType: FieldType;
  /** Current display value */
  content: (Run | Hyperlink)[];
  /** Field is locked */
  fldLock?: boolean;
  /** Field is dirty */
  dirty?: boolean;
};

/**
 * Complex field (w:fldChar begin/separate/end with w:instrText)
 */
export type ComplexField = {
  type: "complexField";
  /** Field instruction */
  instruction: string;
  /** Parsed field type */
  fieldType: FieldType;
  /** Field code runs */
  fieldCode: Run[];
  /** Display result runs */
  fieldResult: Run[];
  /** Field is locked */
  fldLock?: boolean;
  /** Field is dirty */
  dirty?: boolean;
};

export type Field = SimpleField | ComplexField;

// ============================================================================
// IMAGES
// ============================================================================

/**
 * Image size specification
 */
export type ImageSize = {
  /** Width in EMUs (English Metric Units) */
  width: number;
  /** Height in EMUs */
  height: number;
};

/**
 * Image wrap type for floating images
 */
export type ImageWrap = {
  type:
    | "inline"
    | "square"
    | "tight"
    | "through"
    | "topAndBottom"
    | "behind"
    | "inFront";
  /** Wrap text direction */
  wrapText?: "bothSides" | "left" | "right" | "largest";
  /** Distance from text */
  distT?: number;
  distB?: number;
  distL?: number;
  distR?: number;
};

/**
 * Position for floating images
 */
export type ImagePosition = {
  /** Horizontal positioning */
  horizontal: {
    relativeTo:
      | "character"
      | "column"
      | "insideMargin"
      | "leftMargin"
      | "margin"
      | "outsideMargin"
      | "page"
      | "rightMargin";
    alignment?: "left" | "right" | "center" | "inside" | "outside";
    posOffset?: number;
  };
  /** Vertical positioning */
  vertical: {
    relativeTo:
      | "insideMargin"
      | "line"
      | "margin"
      | "outsideMargin"
      | "page"
      | "paragraph"
      | "topMargin"
      | "bottomMargin";
    alignment?: "top" | "bottom" | "center" | "inside" | "outside";
    posOffset?: number;
  };
};

/**
 * Image transformation
 */
export type ImageTransform = {
  /** Rotation in degrees */
  rotation?: number;
  /** Flip horizontal */
  flipH?: boolean;
  /** Flip vertical */
  flipV?: boolean;
};

/**
 * Image padding/margins
 */
export type ImagePadding = {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
};

/**
 * Image crop fractions in [0, 1] applied to each side of the source bitmap.
 * Mirrors the four `<a:srcRect>` attributes (`l`, `t`, `r`, `b`) defined in
 * ECMA-376 §20.1.8.55, stored in 1/100000 units on the wire.
 *
 * eigenpal #424 (image-crop subset).
 */
export type ImageCrop = {
  left?: number;
  top?: number;
  right?: number;
  bottom?: number;
};

/**
 * Embedded image (w:drawing)
 */
export type Image = {
  type: "image";
  /** Unique ID */
  id?: string;
  /** Relationship ID for the image data */
  rId: string;
  /** Resolved image data (base64 or blob URL) */
  src?: string;
  /** Image MIME type */
  mimeType?: string;
  /** Original filename */
  filename?: string;
  /** Alt text for accessibility */
  alt?: string;
  /** Title/description */
  title?: string;
  /** Image size */
  size: ImageSize;
  /** Original size before any transforms */
  originalSize?: ImageSize;
  /** Wrap settings */
  wrap: ImageWrap;
  /** Position for floating images */
  position?: ImagePosition;
  /** Image transformations */
  transform?: ImageTransform;
  /** Padding around image */
  padding?: ImagePadding;
  /** Source-bitmap crop (wp:srcRect), eigenpal #424 */
  crop?: ImageCrop;
  /**
   * Opacity in [0, 1] (OOXML `a:alphaModFix amt`). Undefined or `1` means
   * fully opaque. Mirrors eigenpal docx-editor #424.
   */
  opacity?: number;
  /**
   * `wp:anchor layoutInCell` — when true (OOXML default), an anchored image
   * inside a table cell is constrained to the cell. When false, the image
   * escapes the cell into the page area. Round-tripped on save so the
   * author's intent survives; undefined means "use the spec default".
   */
  layoutInCell?: boolean;
  /**
   * `wp:anchor allowOverlap` — when true (OOXML default), anchored objects
   * may overlap; when false, Word repositions them to avoid collisions. We
   * don't currently reposition, but we round-trip the flag so saving
   * preserves the author's intent; undefined means "use the spec default".
   */
  allowOverlap?: boolean;
  /** Whether this is a decorative image */
  decorative?: boolean;
  /** Hyperlink URL for clickable image */
  hlinkHref?: string;
  /** Image outline/border */
  outline?: ShapeOutline;
  /** Image effects */
  effects?: {
    brightness?: number;
    contrast?: number;
    saturation?: number;
  };
};

// ============================================================================
// SHAPES & TEXT BOXES
// ============================================================================

/**
 * Shape types
 */
export type ShapeType =
  // Basic shapes
  | "rect"
  | "roundRect"
  | "ellipse"
  | "triangle"
  | "rtTriangle"
  | "parallelogram"
  | "trapezoid"
  | "pentagon"
  | "hexagon"
  | "heptagon"
  | "octagon"
  | "decagon"
  | "dodecagon"
  | "star4"
  | "star5"
  | "star6"
  | "star7"
  | "star8"
  | "star10"
  | "star12"
  | "star16"
  | "star24"
  | "star32"
  // Lines and connectors
  | "line"
  | "straightConnector1"
  | "bentConnector2"
  | "bentConnector3"
  | "bentConnector4"
  | "bentConnector5"
  | "curvedConnector2"
  | "curvedConnector3"
  | "curvedConnector4"
  | "curvedConnector5"
  // Arrows
  | "rightArrow"
  | "leftArrow"
  | "upArrow"
  | "downArrow"
  | "leftRightArrow"
  | "upDownArrow"
  | "quadArrow"
  | "leftRightUpArrow"
  | "bentArrow"
  | "uturnArrow"
  | "leftUpArrow"
  | "bentUpArrow"
  | "curvedRightArrow"
  | "curvedLeftArrow"
  | "curvedUpArrow"
  | "curvedDownArrow"
  | "stripedRightArrow"
  | "notchedRightArrow"
  | "homePlate"
  | "chevron"
  | "rightArrowCallout"
  | "downArrowCallout"
  | "leftArrowCallout"
  | "upArrowCallout"
  | "leftRightArrowCallout"
  | "quadArrowCallout"
  | "circularArrow"
  // Flowchart
  | "flowChartProcess"
  | "flowChartAlternateProcess"
  | "flowChartDecision"
  | "flowChartInputOutput"
  | "flowChartPredefinedProcess"
  | "flowChartInternalStorage"
  | "flowChartDocument"
  | "flowChartMultidocument"
  | "flowChartTerminator"
  | "flowChartPreparation"
  | "flowChartManualInput"
  | "flowChartManualOperation"
  | "flowChartConnector"
  | "flowChartOffpageConnector"
  | "flowChartPunchedCard"
  | "flowChartPunchedTape"
  | "flowChartSummingJunction"
  | "flowChartOr"
  | "flowChartCollate"
  | "flowChartSort"
  | "flowChartExtract"
  | "flowChartMerge"
  | "flowChartOnlineStorage"
  | "flowChartDelay"
  | "flowChartMagneticTape"
  | "flowChartMagneticDisk"
  | "flowChartMagneticDrum"
  | "flowChartDisplay"
  // Callouts
  | "wedgeRectCallout"
  | "wedgeRoundRectCallout"
  | "wedgeEllipseCallout"
  | "cloudCallout"
  | "borderCallout1"
  | "borderCallout2"
  | "borderCallout3"
  | "accentCallout1"
  | "accentCallout2"
  | "accentCallout3"
  | "callout1"
  | "callout2"
  | "callout3"
  | "accentBorderCallout1"
  | "accentBorderCallout2"
  | "accentBorderCallout3"
  // Other
  | "actionButtonBlank"
  | "actionButtonHome"
  | "actionButtonHelp"
  | "actionButtonInformation"
  | "actionButtonBackPrevious"
  | "actionButtonForwardNext"
  | "actionButtonBeginning"
  | "actionButtonEnd"
  | "actionButtonReturn"
  | "actionButtonDocument"
  | "actionButtonSound"
  | "actionButtonMovie"
  | "irregularSeal1"
  | "irregularSeal2"
  | "frame"
  | "halfFrame"
  | "corner"
  | "diagStripe"
  | "chord"
  | "arc"
  | "bracketPair"
  | "bracePair"
  | "leftBracket"
  | "rightBracket"
  | "leftBrace"
  | "rightBrace"
  | "can"
  | "cube"
  | "bevel"
  | "donut"
  | "noSmoking"
  | "blockArc"
  | "foldedCorner"
  | "smileyFace"
  | "heart"
  | "lightningBolt"
  | "sun"
  | "moon"
  | "cloud"
  | "snip1Rect"
  | "snip2SameRect"
  | "snip2DiagRect"
  | "snipRoundRect"
  | "round1Rect"
  | "round2SameRect"
  | "round2DiagRect"
  | "plaque"
  | "teardrop"
  | "mathPlus"
  | "mathMinus"
  | "mathMultiply"
  | "mathDivide"
  | "mathEqual"
  | "mathNotEqual"
  | "gear6"
  | "gear9"
  | "funnel"
  | "pieWedge"
  | "pie"
  | "leftCircularArrow"
  | "leftRightCircularArrow"
  | "swooshArrow"
  | "textBox";

/**
 * Shape fill type
 */
export type ShapeFill = {
  type: "none" | "solid" | "gradient" | "pattern" | "picture";
  /** Solid fill color */
  color?: ColorValue;
  /** Gradient stops for gradient fill */
  gradient?: {
    type: "linear" | "radial" | "rectangular" | "path";
    angle?: number;
    stops: {
      position: number; // 0-100000
      color: ColorValue;
    }[];
  };
};

/**
 * Shape outline/stroke
 */
export type ShapeOutline = {
  /** Line width in EMUs */
  width?: number;
  /** Line color */
  color?: ColorValue;
  /** Line style */
  style?:
    | "solid"
    | "dot"
    | "dash"
    | "lgDash"
    | "dashDot"
    | "lgDashDot"
    | "lgDashDotDot"
    | "sysDot"
    | "sysDash"
    | "sysDashDot"
    | "sysDashDotDot";
  /** Line cap */
  cap?: "flat" | "round" | "square";
  /** Line join */
  join?: "bevel" | "miter" | "round";
  /** Head arrow */
  headEnd?: {
    type: "none" | "triangle" | "stealth" | "diamond" | "oval" | "arrow";
    width?: "sm" | "med" | "lg";
    length?: "sm" | "med" | "lg";
  };
  /** Tail arrow */
  tailEnd?: {
    type: "none" | "triangle" | "stealth" | "diamond" | "oval" | "arrow";
    width?: "sm" | "med" | "lg";
    length?: "sm" | "med" | "lg";
  };
};

/**
 * Text body inside a shape
 */
export type ShapeTextBody = {
  /** Text direction */
  vertical?: boolean;
  /** Rotation */
  rotation?: number;
  /** Anchor/vertical alignment */
  anchor?: "top" | "middle" | "bottom" | "distributed" | "justified";
  /** Anchor center */
  anchorCenter?: boolean;
  /** Auto fit */
  autoFit?: "none" | "normal" | "shape";
  /** Text margins */
  margins?: {
    top?: number;
    bottom?: number;
    left?: number;
    right?: number;
  };
  /** Paragraphs inside the shape */
  content: Paragraph[];
};

/**
 * Shape/drawing object (wps:wsp)
 */
export type Shape = {
  type: "shape";
  /** Shape type preset */
  shapeType: ShapeType;
  /** Unique ID */
  id?: string;
  /** Name */
  name?: string;
  /** Size in EMUs */
  size: ImageSize;
  /** Position for floating shapes */
  position?: ImagePosition;
  /** Wrap settings */
  wrap?: ImageWrap;
  /** Fill */
  fill?: ShapeFill;
  /** Outline/stroke */
  outline?: ShapeOutline;
  /** Transform */
  transform?: ImageTransform;
  /** Text content inside the shape */
  textBody?: ShapeTextBody;
  /** Custom geometry points */
  customGeometry?: string;
};

/**
 * Text box (floating text container)
 */
export type TextBox = {
  type: "textBox";
  /** Unique ID */
  id?: string;
  /** Size */
  size: ImageSize;
  /** Position */
  position?: ImagePosition;
  /** Wrap settings */
  wrap?: ImageWrap;
  /** Fill */
  fill?: ShapeFill;
  /** Outline */
  outline?: ShapeOutline;
  /** Text content */
  content: Paragraph[];
  /** Internal margins */
  margins?: {
    top?: number;
    bottom?: number;
    left?: number;
    right?: number;
  };
};

// ============================================================================
// TABLES
// ============================================================================

/**
 * Table cell
 */
export type TableCell = {
  type: "tableCell";
  /** Cell formatting */
  formatting?: TableCellFormatting;
  /** Cell-level tracked property changes (w:tcPrChange) */
  propertyChanges?: TableCellPropertyChange[];
  /** Tracked structural changes (cell insert/delete/merge) */
  structuralChange?: TableStructuralChangeInfo;
  /** Cell content (paragraphs, tables, etc.) */
  content: (Paragraph | Table)[];
};

/**
 * Table row
 */
export type TableRow = {
  type: "tableRow";
  /** Row formatting */
  formatting?: TableRowFormatting;
  /** Row-level tracked property changes (w:trPrChange) */
  propertyChanges?: TableRowPropertyChange[];
  /** Tracked structural changes (row insert/delete) */
  structuralChange?: TableStructuralChangeInfo;
  /** Cells in this row */
  cells: TableCell[];
};

/**
 * Table (w:tbl)
 */
export type Table = {
  type: "table";
  /** Table formatting */
  formatting?: TableFormatting;
  /** Table-level tracked property changes (w:tblPrChange) */
  propertyChanges?: TablePropertyChange[];
  /** Column widths in twips */
  columnWidths?: number[];
  /** Table rows */
  rows: TableRow[];
};

// ============================================================================
// COMMENTS
// ============================================================================

/**
 * A comment (w:comment) from comments.xml
 */
export type Comment = {
  /** Comment ID (matches commentRangeStart/End) */
  id: number;
  /** Author name */
  author: string;
  /** Author initials */
  initials?: string;
  /** Date */
  date?: string;
  /** Comment content (paragraphs) */
  content: Paragraph[];
  /** Parent comment ID (for replies) */
  parentId?: number;
  /** Whether the comment is resolved/done */
  done?: boolean;
};

/**
 * Comment range start marker in paragraph content
 */
export type CommentRangeStart = {
  type: "commentRangeStart";
  id: number;
};

/**
 * Comment range end marker in paragraph content
 */
export type CommentRangeEnd = {
  type: "commentRangeEnd";
  id: number;
};

/**
 * Point comment reference (w:commentReference without an explicit range).
 * Word sometimes stores comments this way; we anchor them to nearby text for display.
 */
export type CommentReference = {
  type: "commentReference";
  id: number;
};

// ============================================================================
// MATH EQUATIONS
// ============================================================================

/**
 * Math equation content (m:oMath or m:oMathPara)
 */
export type MathEquation = {
  type: "mathEquation";
  /** Whether this is a block (oMathPara) or inline (oMath) equation */
  display: "inline" | "block";
  /** Raw OMML XML for round-trip preservation */
  ommlXml: string;
  /** Plain text representation for accessibility/fallback */
  plainText?: string;
};

// ============================================================================
// TRACKED CHANGES
// ============================================================================

/**
 * Tracked change metadata (w:ins, w:del attributes)
 */
export type TrackedChangeInfo = {
  /** Revision ID */
  id: number;
  /** Author who made the change */
  author: string;
  /** Date of the change */
  date?: string;
};

/**
 * Generic tracked property-change wrapper metadata (w:*PrChange)
 */
export type PropertyChangeInfo = {
  /** Optional revision session ID */
  rsid?: string;
} & TrackedChangeInfo;

/**
 * Insertion wrapper (w:ins) — runs inserted by tracked changes
 */
export type Insertion = {
  type: "insertion";
  /** Tracked change metadata */
  info: TrackedChangeInfo;
  /** Inserted content */
  content: (Run | Hyperlink)[];
};

/**
 * Deletion wrapper (w:del) — runs deleted by tracked changes
 */
export type Deletion = {
  type: "deletion";
  /** Tracked change metadata */
  info: TrackedChangeInfo;
  /** Deleted content */
  content: (Run | Hyperlink)[];
};

/**
 * Move-from wrapper (w:moveFrom) â€” content moved away from this position
 */
export type MoveFrom = {
  type: "moveFrom";
  /** Tracked change metadata */
  info: TrackedChangeInfo;
  /** Moved content */
  content: (Run | Hyperlink)[];
};

/**
 * Move-to wrapper (w:moveTo) â€” content moved into this position
 */
export type MoveTo = {
  type: "moveTo";
  /** Tracked change metadata */
  info: TrackedChangeInfo;
  /** Moved content */
  content: (Run | Hyperlink)[];
};

/**
 * Move-from range start marker (w:moveFromRangeStart) — ECMA-376 §17.13.5.22
 * Pairs with moveFromRangeEnd to delimit the source of a move in the document.
 */
export type MoveFromRangeStart = {
  type: "moveFromRangeStart";
  id: number;
  name: string;
};

/**
 * Move-from range end marker (w:moveFromRangeEnd)
 */
export type MoveFromRangeEnd = {
  type: "moveFromRangeEnd";
  id: number;
};

/**
 * Move-to range start marker (w:moveToRangeStart) — ECMA-376 §17.13.5.24
 * Pairs with moveToRangeEnd to delimit the destination of a move.
 */
export type MoveToRangeStart = {
  type: "moveToRangeStart";
  id: number;
  name: string;
};

/**
 * Move-to range end marker (w:moveToRangeEnd)
 */
export type MoveToRangeEnd = {
  type: "moveToRangeEnd";
  id: number;
};

/**
 * Run-level tracked wrappers represented in WordprocessingML.
 */
export type TrackedRunChange = Insertion | Deletion | MoveFrom | MoveTo;

/**
 * Run property change (w:rPrChange)
 */
export type RunPropertyChange = {
  type: "runPropertyChange";
  /** Tracked change metadata */
  info: PropertyChangeInfo;
  /** Run properties before the tracked change */
  previousFormatting?: TextFormatting;
  /** Run properties after the tracked change (editor model convenience) */
  currentFormatting?: TextFormatting;
};

/**
 * Paragraph property change (w:pPrChange)
 */
export type ParagraphPropertyChange = {
  type: "paragraphPropertyChange";
  /** Tracked change metadata */
  info: PropertyChangeInfo;
  /** Paragraph properties before the tracked change */
  previousFormatting?: ParagraphFormatting;
  /** Paragraph properties after the tracked change (editor model convenience) */
  currentFormatting?: ParagraphFormatting;
};

/**
 * Table property change (w:tblPrChange)
 */
export type TablePropertyChange = {
  type: "tablePropertyChange";
  /** Tracked change metadata */
  info: PropertyChangeInfo;
  /** Table properties before the tracked change */
  previousFormatting?: TableFormatting;
  /** Table properties after the tracked change (editor model convenience) */
  currentFormatting?: TableFormatting;
};

/**
 * Table row property change (w:trPrChange)
 */
export type TableRowPropertyChange = {
  type: "tableRowPropertyChange";
  /** Tracked change metadata */
  info: PropertyChangeInfo;
  /** Row properties before the tracked change */
  previousFormatting?: TableRowFormatting;
  /** Row properties after the tracked change (editor model convenience) */
  currentFormatting?: TableRowFormatting;
};

/**
 * Table cell property change (w:tcPrChange)
 */
export type TableCellPropertyChange = {
  type: "tableCellPropertyChange";
  /** Tracked change metadata */
  info: PropertyChangeInfo;
  /** Cell properties before the tracked change */
  previousFormatting?: TableCellFormatting;
  /** Cell properties after the tracked change (editor model convenience) */
  currentFormatting?: TableCellFormatting;
};

/**
 * Section property change (w:sectPrChange)
 */
export type SectionPropertyChange = {
  type: "sectionPropertyChange";
  /** Tracked change metadata */
  info: PropertyChangeInfo;
  /** Section properties before the tracked change */
  previousProperties?: SectionProperties;
  /** Section properties after the tracked change (editor model convenience) */
  currentProperties?: SectionProperties;
};

/**
 * Table structural tracked change metadata (row/cell insert/delete/merge)
 */
export type TableStructuralChangeInfo = {
  type:
    | "tableRowInsertion"
    | "tableRowDeletion"
    | "tableCellInsertion"
    | "tableCellDeletion"
    | "tableCellMerge";
  /** Tracked change metadata */
  info: TrackedChangeInfo;
};

// ============================================================================
// STRUCTURED DOCUMENT TAGS (SDT / Content Controls)
// ============================================================================

/**
 * SDT type (content control type)
 */
export type SdtType =
  | "richText"
  | "plainText"
  | "date"
  | "dropdown"
  | "comboBox"
  | "checkbox"
  | "picture"
  | "buildingBlockGallery"
  | "group"
  | "unknown";

/**
 * SDT properties (`w:sdtPr`).
 *
 * Modeled fields are a read-only projection for downstream tooling
 * (tag/alias addressing, template extraction). They are NOT the
 * serialization source: the original `<w:sdtPr>` is captured verbatim in
 * `rawPropertiesXml` and replayed on save, which preserves element order
 * (`CT_SdtPr` is an `xsd:sequence`), avoids double-emission, and keeps
 * unmodeled features (`w:dataBinding`, `w15:repeatingSection`, `@lastValue`,
 * `w:sdtEndPr`) lossless.
 */
export type SdtProperties = {
  /** SDT type (projection; round-trip uses `rawPropertiesXml`). */
  sdtType: SdtType;
  /** Numeric id (`w:id/@w:val`). */
  id?: number;
  /** Alias (friendly name, `w:alias`). */
  alias?: string;
  /** Tag (developer identifier, `w:tag`). */
  tag?: string;
  /** Lock setting (`w:lock`). */
  lock?: "sdtLocked" | "contentLocked" | "sdtContentLocked" | "unlocked";
  /**
   * Placeholder building-block name (`w:placeholder/w:docPart@w:val`) — a
   * reference to a glossary docPart, not the literal placeholder text.
   */
  placeholder?: string;
  /** Whether the placeholder is currently shown (`w:showingPlcHdr`). */
  showingPlaceholder?: boolean;
  /** Date display format (`w:date/w:dateFormat@w:val`). */
  dateFormat?: string;
  /**
   * Bound date value (`w:date/@w:fullDate`), ISO 8601. Independent of
   * `dateFormat` (which controls display): the body text may show a
   * formatted version like "2 June 2026" while this stays as
   * `2026-06-02T00:00:00Z` so Word's date binding round-trips losslessly.
   */
  dateValueISO?: string;
  /** Dropdown/combobox list items. */
  listItems?: { displayText: string; value: string }[];
  /**
   * Selected dropdown / comboBox value (`w:dropDownList@w:lastValue`).
   * Persisted as the OOXML value, independent of the body display text.
   * Without this, the serializer had to recover the saved value by
   * matching the body's display text against `listItems`, which picked
   * the wrong entry when two items shared a `displayText`.
   */
  dropdownLastValue?: string;
  /** Checkbox checked state (`w14:checkbox/w14:checked`). */
  checked?: boolean;
  /**
   * Verbatim `<w:sdtPr>…</w:sdtPr>` captured at parse time. Replayed on
   * serialize so unmodeled OOXML features (data binding, repeating sections,
   * `@lastValue`, custom XML mappings) survive round-trip.
   */
  rawPropertiesXml?: string;
  /** Verbatim `<w:sdtEndPr>…</w:sdtEndPr>` captured at parse time. */
  rawEndPropertiesXml?: string;
  /**
   * Verbatim XML for any non-content direct children of `<w:sdt>` that
   * appear BEFORE `<w:sdtContent>` — MS-OE376 §2.5.2.30 documents 16
   * range-marker elements Word emits as direct sdt siblings (bookmark,
   * comment range, custom XML range, tracked-change range). Captured at
   * parse time and replayed on serialize so comment threads or tracked
   * changes that span an SDT boundary round-trip without losing a
   * delimiter.
   */
  rawSdtChildrenBeforeContent?: string;
  /** Verbatim XML for non-content sdt children that appear AFTER `<w:sdtContent>`. */
  rawSdtChildrenAfterContent?: string;
};

/**
 * Inline SDT (content control within a paragraph).
 *
 * OOXML allows runs, hyperlinks, simple/complex fields, nested SDTs,
 * and math at this level. All of them must survive parse → edit → save
 * so docProps-bound fields and similar template content do not lose
 * their wrapper on round-trip.
 */
export type InlineSdt = {
  type: "inlineSdt";
  /** SDT properties */
  properties: SdtProperties;
  /** Inline content held inside the control */
  content: (
    | Run
    | Hyperlink
    | SimpleField
    | ComplexField
    | InlineSdt
    | MathEquation
  )[];
};

/**
 * Block-level SDT (content control wrapping paragraphs/tables).
 *
 * Content is `BlockContent[]` (not just `(Paragraph | Table)[]`) because
 * OOXML allows block SDTs to nest — e.g. a repeating-section control
 * whose row is itself a content control.
 */
export type BlockSdt = {
  type: "blockSdt";
  /** SDT properties (raw XML in `properties.rawPropertiesXml` round-trips losslessly). */
  properties: SdtProperties;
  /** Block content inside the control. */
  content: BlockContent[];
};

// ============================================================================
// PARAGRAPH
// ============================================================================

/**
 * Paragraph content types
 */
export type ParagraphContent =
  | Run
  | Hyperlink
  | BookmarkStart
  | BookmarkEnd
  | SimpleField
  | ComplexField
  | InlineSdt
  | CommentRangeStart
  | CommentRangeEnd
  | CommentReference
  | Insertion
  | Deletion
  | MoveFrom
  | MoveTo
  | MoveFromRangeStart
  | MoveFromRangeEnd
  | MoveToRangeStart
  | MoveToRangeEnd
  | MathEquation;

/**
 * Paragraph (w:p)
 */
/**
 * Paragraph-mark tracked-change marker (ECMA-376 §17.13.5).
 *
 * Word writes this as a child of `<w:pPr><w:rPr>` — `<w:ins/>` when the
 * paragraph break itself was inserted in track-changes mode (the user
 * pressed Enter mid-paragraph), `<w:del/>` when the paragraph break is
 * pending deletion (Backspace at paragraph start or Delete at paragraph
 * end). The mark is independent of the inline runs the paragraph carries.
 */
export type ParagraphMarkChange = {
  kind: "ins" | "del";
  info: TrackedChangeInfo;
};

export type Paragraph = {
  type: "paragraph";
  /** Unique paragraph ID */
  paraId?: string;
  /** Text ID */
  textId?: string;
  /** Paragraph formatting */
  formatting?: ParagraphFormatting;
  /** Paragraph-level tracked property changes (w:pPrChange) */
  propertyChanges?: ParagraphPropertyChange[];
  /** Paragraph-mark insertion / deletion (w:pPr / w:rPr / w:ins | w:del) */
  pPrMark?: ParagraphMarkChange;
  /** Paragraph content */
  content: ParagraphContent[];
  /** Computed list rendering (if this is a list item) */
  listRendering?: ListRendering;
  /** Word's cached layout says this paragraph started on a new rendered page. */
  renderedPageBreakBefore?: boolean;
  /** Section properties (if this paragraph ends a section) */
  sectionProperties?: SectionProperties;
};

// ============================================================================
// HEADERS & FOOTERS
// ============================================================================

/**
 * Header/footer type
 */
export type HeaderFooterType = "default" | "first" | "even";

/**
 * Header or footer reference
 */
export type HeaderReference = {
  type: HeaderFooterType;
  rId: string;
};

export type FooterReference = {
  type: HeaderFooterType;
  rId: string;
};

/**
 * Header or footer content
 */
export type HeaderFooter = {
  type: "header" | "footer";
  /** Header/footer type */
  hdrFtrType: HeaderFooterType;
  /** Content (paragraphs, tables, block-level content controls). */
  content: BlockContent[];
  /**
   * Document watermark detected in this header part. Word emits
   * watermarks as VML or DrawingML behind-content shapes inside header
   * parts; the body paragraph that contains them is empty otherwise.
   * The modeled `Watermark` is exposed alongside `content` so callers
   * can render and edit it without walking raw runs.
   */
  watermark?: Watermark;
  /**
   * Verbatim XML of the paragraph(s) containing the source watermark
   * shape. Captured at parse time so an untouched DOCX serializes the
   * watermark byte-exact even though `runParser` does not surface VML /
   * DrawingML at the run level. Cleared (or rewritten) when callers
   * mutate the modeled watermark via the headless API.
   */
  rawWatermarkXml?: string;
  /**
   * Index where the watermark paragraph sat among block-level siblings
   * in the source header. The serializer inserts the watermark (raw or
   * synthesized) at this position so a header that originally placed
   * the watermark after visible text round-trips with the same flow.
   * Undefined when no watermark was parsed or when callers built the
   * watermark programmatically — in that case the serializer emits it
   * at the top of the header (the same position Word's own UI uses).
   */
  watermarkBlockIndex?: number;
};

/**
 * Document watermark (MS Word's behind-content page decoration).
 */
export type Watermark = TextWatermark | PictureWatermark;

export type TextWatermark = {
  kind: "text";
  /** Visible string. Required. */
  text: string;
  /** Font family. Word's default is Calibri. */
  font?: string;
  /**
   * Hex color (`"C0C0C0"`), `"auto"`, or `undefined` for the producer
   * default. Word emits `#C0C0C0` (light gray) for text watermarks.
   */
  color?: string;
  /**
   * `true` = diagonal (Word default, -45°), `false` = horizontal.
   * Stored as a boolean since the only Word-supported rotations are
   * -45 and 0.
   */
  diagonal?: boolean;
  /**
   * Opacity 0..1. Word's interactive UI exposes a "transparency"
   * percentage; folio stores it as an opacity scalar for renderer
   * convenience. Default ~0.5.
   */
  opacity?: number;
};

export type PictureWatermark = {
  kind: "picture";
  /** Relationship id of the image part in `word/_rels/header*.xml.rels`. */
  imageRId: string;
  /** Optional scale factor (1.0 = native, 0.5 = half-size). */
  scale?: number;
  /**
   * Whether Word's "washout" effect was applied (low contrast).
   * Default true — Word emits washout=true on every picture
   * watermark inserted via Insert → Watermark.
   */
  washout?: boolean;
};

// ============================================================================
// FOOTNOTES & ENDNOTES
// ============================================================================

/**
 * Footnote position
 */
export type FootnotePosition =
  | "pageBottom"
  | "beneathText"
  | "sectEnd"
  | "docEnd";

/**
 * Endnote position
 */
export type EndnotePosition = "sectEnd" | "docEnd";

/**
 * Number restart type
 */
export type NoteNumberRestart = "continuous" | "eachSect" | "eachPage";

/**
 * Footnote properties
 */
export type FootnoteProperties = {
  position?: FootnotePosition;
  numFmt?: NumberFormat;
  numStart?: number;
  numRestart?: NoteNumberRestart;
};

/**
 * Endnote properties
 */
export type EndnoteProperties = {
  position?: EndnotePosition;
  numFmt?: NumberFormat;
  numStart?: number;
  numRestart?: NoteNumberRestart;
};

/**
 * Footnote (w:footnote)
 */
export type Footnote = {
  type: "footnote";
  /** Footnote ID */
  id: number;
  /** Special footnote type */
  noteType?:
    | "normal"
    | "separator"
    | "continuationSeparator"
    | "continuationNotice";
  /**
   * Content. Note bodies may carry block-level `<w:sdt>` content
   * controls (citation slots, bound metadata fields) — preserved as
   * `BlockSdt` so the rest of folio's SDT round-trip + mutate APIs
   * work in notes the same as they do in the main body. Mirrors the
   * shape upstream eigenpal/docx-editor#678 fixed for the same case.
   */
  content: (Paragraph | Table | BlockSdt)[];
};

/**
 * Endnote (w:endnote)
 */
export type Endnote = {
  type: "endnote";
  /** Endnote ID */
  id: number;
  /** Special endnote type */
  noteType?:
    | "normal"
    | "separator"
    | "continuationSeparator"
    | "continuationNotice";
  /**
   * Content. Like `Footnote.content`, may carry block-level `<w:sdt>`
   * preserved as `BlockSdt` so SDT round-trip works inside endnotes.
   */
  content: (Paragraph | Table | BlockSdt)[];
};

// ============================================================================
// SECTION PROPERTIES
// ============================================================================

/**
 * Page orientation
 */
export type PageOrientation = "portrait" | "landscape";

/**
 * Section start type
 */
export type SectionStart =
  | "continuous"
  | "nextPage"
  | "oddPage"
  | "evenPage"
  | "nextColumn";

/**
 * Vertical alignment
 */
export type VerticalAlign = "top" | "center" | "both" | "bottom";

/**
 * Line number restart type
 */
export type LineNumberRestart = "continuous" | "newPage" | "newSection";

/**
 * Column definition
 */
export type Column = {
  /** Column width in twips */
  width?: number;
  /** Space after column in twips */
  space?: number;
};

/**
 * Section properties (w:sectPr)
 */
export type SectionTextDirection =
  | "lrTb"
  | "tbRl"
  | "btLr"
  | "lrTbV"
  | "tbRlV"
  | "tbLrV"
  | "tb"
  | "rl"
  | "lr"
  | "tbV"
  | "rlV"
  | "lrV";

export type SectionProperties = {
  // Page size
  /** Page width in twips */
  pageWidth?: number;
  /** Page height in twips */
  pageHeight?: number;
  /** Page orientation */
  orientation?: PageOrientation;

  // Margins
  /** Top margin in twips */
  marginTop?: number;
  /** Bottom margin in twips */
  marginBottom?: number;
  /** Left margin in twips */
  marginLeft?: number;
  /** Right margin in twips */
  marginRight?: number;
  /** Header distance from top in twips */
  headerDistance?: number;
  /** Footer distance from bottom in twips */
  footerDistance?: number;
  /** Gutter margin in twips */
  gutter?: number;

  // Columns
  /** Number of columns */
  columnCount?: number;
  /** Space between columns in twips */
  columnSpace?: number;
  /** Equal width columns */
  equalWidth?: boolean;
  /** Separator line between columns */
  separator?: boolean;
  /** Individual column definitions */
  columns?: Column[];

  // Section behavior
  /** Section start type */
  sectionStart?: SectionStart;
  /** Vertical alignment of text */
  verticalAlign?: VerticalAlign;
  /** Section text direction */
  textDirection?: SectionTextDirection;
  /** Right-to-left section */
  bidi?: boolean;

  // Headers and footers
  /** Header references */
  headerReferences?: HeaderReference[];
  /** Footer references */
  footerReferences?: FooterReference[];
  /** Different first page header/footer */
  titlePg?: boolean;
  /** Different odd/even page headers/footers */
  evenAndOddHeaders?: boolean;

  // Line numbers
  /** Line numbering settings */
  lineNumbers?: {
    start?: number;
    countBy?: number;
    distance?: number;
    restart?: LineNumberRestart;
  };

  // Page numbers
  /** Page numbering settings */
  pageNumbering?: {
    format?: string;
    start?: number;
    chapterStyle?: number;
    chapterSeparator?: string;
  };

  // Page borders
  /** Page borders */
  pageBorders?: {
    top?: BorderSpec;
    bottom?: BorderSpec;
    left?: BorderSpec;
    right?: BorderSpec;
    /** Display setting */
    display?: "allPages" | "firstPage" | "notFirstPage";
    /** Offset from */
    offsetFrom?: "page" | "text";
    /** Z-order */
    zOrder?: "front" | "back";
  };

  // Background
  /** Page background */
  background?: {
    color?: ColorValue;
    themeColor?: ThemeColorSlot;
    themeTint?: string;
    themeShade?: string;
  };

  // Footnote/Endnote properties
  /** Footnote properties for this section */
  footnotePr?: FootnoteProperties;
  /** Number of footnote columns in this section (`w15:footnoteColumns`) */
  footnoteColumns?: number;
  /** Endnote properties for this section */
  endnotePr?: EndnoteProperties;

  // Document grid
  /** Document grid */
  docGrid?: {
    type?: "default" | "lines" | "linesAndChars" | "snapToChars";
    linePitch?: number;
    charSpace?: number;
  };

  // Paper source
  /** First page paper source */
  paperSrcFirst?: number;
  /** Other pages paper source */
  paperSrcOther?: number;

  // Section-level flags and relationships
  /** Protected forms in this section */
  formProtection?: boolean;
  /** Suppress endnotes in this section */
  noEndnote?: boolean;
  /** Use right-to-left gutter in this section */
  rtlGutter?: boolean;
  /** Relationship id for printer settings */
  printerSettingsRelationshipId?: string;

  /** Section-level tracked property changes (w:sectPrChange) */
  propertyChanges?: SectionPropertyChange[];
};

// ============================================================================
// SECTION & DOCUMENT BODY
// ============================================================================

/**
 * Block-level content types
 */
export type BlockContent = Paragraph | Table | BlockSdt;

/**
 * Section (implicit or explicit based on sectPr)
 */
export type Section = {
  /** Section properties */
  properties: SectionProperties;
  /** Content in this section */
  content: BlockContent[];
  /** Headers for this section */
  headers?: Map<HeaderFooterType, HeaderFooter>;
  /** Footers for this section */
  footers?: Map<HeaderFooterType, HeaderFooter>;
};

/**
 * Document body (w:body)
 */
export type DocumentBody = {
  /** All content (paragraphs, tables) */
  content: BlockContent[];
  /** Sections (derived from sectPr in paragraphs and final sectPr) */
  sections?: Section[];
  /** Final section properties (from body's sectPr) */
  finalSectionProperties?: SectionProperties;
  /** Comments from comments.xml */
  comments?: Comment[];
};
