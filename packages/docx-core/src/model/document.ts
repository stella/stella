/**
 * Comprehensive TypeScript types for full DOCX document representation
 *
 * This barrel file re-exports all types from the split modules.
 * Existing imports from './types/document' continue to work unchanged.
 *
 * Module structure:
 * - colors.ts      — Color primitives, borders, shading
 * - formatting.ts  — Text, paragraph, and table formatting properties
 * - lists.ts       — Numbering and list definitions
 * - content.ts     — Content model (runs, images, shapes, tables, paragraphs, sections)
 * - styles.ts      — Styles, theme, fonts, relationships, media
 */

import type { DocumentBody, Footnote, Endnote, HeaderFooter } from "./content";
import type { NumberingDefinitions } from "./lists";
import type {
  StyleDefinitions,
  Theme,
  FontTable,
  RelationshipMap,
  MediaFile,
} from "./styles";

// Color & Styling Primitives
export type {
  ThemeColorSlot,
  ColorValue,
  KnownBorderStyle,
  BorderSpec,
  ShadingProperties,
} from "./colors";

// Text & Paragraph Formatting
export type {
  UnderlineStyle,
  TextEffect,
  EmphasisMark,
  TextFormatting,
  TabStopAlignment,
  TabLeader,
  TabStop,
  LineSpacingRule,
  ParagraphAlignment,
  ParagraphFormatting,
  SpacingExplicit,
  TableWidthType,
  TableMeasurement,
  TableBorders,
  CellMargins,
  TableLook,
  FloatingTableProperties,
  TableFormatting,
  TableRowFormatting,
  ConditionalFormatStyle,
  TableCellFormatting,
} from "./formatting";

// Lists & Numbering
export type {
  NumberFormat,
  LevelSuffix,
  ListLevel,
  AbstractNumbering,
  NumberingInstance,
  ListRendering,
  NumberingDefinitions,
} from "./lists";

// Content Model
export type {
  TextContent,
  TabContent,
  BreakContent,
  SymbolContent,
  NoteReferenceContent,
  FieldCharContent,
  InstrTextContent,
  SoftHyphenContent,
  NoBreakHyphenContent,
  DrawingContent,
  ShapeContent,
  RunContent,
  Run,
  Hyperlink,
  BookmarkStart,
  BookmarkEnd,
  FieldType,
  SimpleField,
  ComplexField,
  Field,
  ImageSize,
  ImageWrap,
  ImagePosition,
  ImageTransform,
  ImagePadding,
  Image,
  ShapeType,
  ShapeFill,
  ShapeOutline,
  ShapeTextBody,
  Shape,
  TextBox,
  TableCell,
  TableRow,
  Table,
  Comment,
  CommentRangeStart,
  CommentRangeEnd,
  CommentReference,
  MathEquation,
  TrackedChangeInfo,
  TrackedRunChange,
  PropertyChangeInfo,
  Insertion,
  Deletion,
  MoveFrom,
  MoveTo,
  MoveFromRangeStart,
  MoveFromRangeEnd,
  MoveToRangeStart,
  MoveToRangeEnd,
  RunPropertyChange,
  ParagraphPropertyChange,
  TablePropertyChange,
  TableRowPropertyChange,
  TableCellPropertyChange,
  SectionPropertyChange,
  TableStructuralChangeInfo,
  SdtType,
  SdtProperties,
  InlineSdt,
  BlockSdt,
  ParagraphContent,
  Paragraph,
  HeaderFooterType,
  HeaderReference,
  FooterReference,
  HeaderFooter,
  FootnotePosition,
  EndnotePosition,
  NoteNumberRestart,
  FootnoteProperties,
  EndnoteProperties,
  Footnote,
  Endnote,
  PageOrientation,
  SectionStart,
  VerticalAlign,
  LineNumberRestart,
  Column,
  SectionProperties,
  BlockContent,
  Section,
  DocumentBody,
} from "./content";

// Styles, Theme, Fonts, Relationships & Media
export type {
  StyleType,
  Style,
  DocDefaults,
  StyleDefinitions,
  ThemeColorScheme,
  ThemeFont,
  ThemeFontScheme,
  Theme,
  FontInfo,
  FontTable,
  RelationshipType,
  Relationship,
  RelationshipMap,
  MediaFile,
} from "./styles";

// ============================================================================
// DOCX PACKAGE & TOP-LEVEL DOCUMENT
// ============================================================================

/**
 * Document-wide settings parsed from `word/settings.xml`.
 * Extend as more settings.xml fields enter the layout pipeline.
 */
export type DocumentSettings = {
  /**
   * `w:defaultTabStop` (§17.6.13) — interval in twips between default
   * tab stops applied when a paragraph has no custom `w:tabs`. Word
   * defaults to 720 twips (½ inch) when absent.
   */
  defaultTabStop: number;
};

/**
 * Complete DOCX package structure
 */
export type DocxPackage = {
  /** Document body */
  document: DocumentBody;
  /** Document-wide settings (`word/settings.xml`). */
  settings?: DocumentSettings;
  /** Style definitions */
  styles?: StyleDefinitions;
  /** Theme */
  theme?: Theme;
  /** Numbering definitions */
  numbering?: NumberingDefinitions;
  /** Font table */
  fontTable?: FontTable;
  /** Footnotes */
  footnotes?: Footnote[];
  /** Endnotes */
  endnotes?: Endnote[];
  /** Headers by relationship ID */
  headers?: Map<string, HeaderFooter>;
  /** Footers by relationship ID */
  footers?: Map<string, HeaderFooter>;
  /** Document relationships */
  relationships?: RelationshipMap;
  /** Media files */
  media?: Map<string, MediaFile>;
  /** Document properties */
  properties?: {
    title?: string;
    subject?: string;
    creator?: string;
    keywords?: string;
    description?: string;
    lastModifiedBy?: string;
    revision?: number;
    created?: Date;
    modified?: Date;
  };
};

/**
 * Complete parsed DOCX document
 */
export type Document = {
  /** DOCX package with all parsed content */
  package: DocxPackage;
  /** Original ArrayBuffer for round-trip */
  originalBuffer?: ArrayBuffer;
  /** Detected template variables ({{...}}) */
  templateVariables?: string[];
  /** Font families referenced in the document (extracted during parsing for deferred loading) */
  requiredFonts?: string[];
  /** Parsing warnings/errors */
  warnings?: string[];
};
