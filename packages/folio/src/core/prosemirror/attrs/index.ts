import { panic } from "better-result";
import type { Mark, Node as PMNode } from "prosemirror-model";

import {
  FIELD_TYPE_VALUES,
  HIGHLIGHT_COLOR_VALUES,
  IMAGE_HORIZONTAL_ALIGNMENT_VALUES,
  IMAGE_HORIZONTAL_RELATIVE_TO_VALUES,
  IMAGE_VERTICAL_ALIGNMENT_VALUES,
  IMAGE_VERTICAL_RELATIVE_TO_VALUES,
  IMAGE_WRAP_TEXT_VALUES,
  IMAGE_WRAP_TYPE_VALUES,
  LINE_SPACING_RULE_VALUES,
  OUTLINE_STYLE_ATTR_VALUES,
  PARAGRAPH_ALIGNMENT_VALUES,
  SDT_LOCK_VALUES,
  SDT_TYPE_VALUES,
  SHADING_PATTERN_VALUES,
  TABLE_CELL_TEXT_DIRECTION_VALUES,
  TABLE_CELL_VERTICAL_ALIGNMENT_VALUES,
  TABLE_JUSTIFICATION_VALUES,
  TABLE_ROW_HEIGHT_RULE_VALUES,
  TABLE_WIDTH_TYPE_VALUES,
  TAB_LEADER_VALUES,
  TAB_STOP_ALIGNMENT_VALUES,
  TEXT_EFFECT_VALUES,
  THEME_COLOR_SLOT_VALUES,
  UNDERLINE_STYLE_VALUES,
} from "../../types/documentEnumValues";
import type {
  BlockSdtAttrs,
  CharacterSpacingAttrs,
  CharacterStyleAttrs,
  CommentAttrs,
  EmphasisMarkAttrs,
  FieldAttrs,
  FontFamilyAttrs,
  FontSizeAttrs,
  FootnoteRefAttrs,
  HighlightAttrs,
  HyperlinkAttrs,
  HardBreakAttrs,
  ImageAttrs,
  MathAttrs,
  ParagraphAttrs,
  RunFormattingOverrideAttrs,
  RunShadingAttrs,
  SdtAttrs,
  ShapeAttrs,
  StrikeAttrs,
  TableAttrs,
  TableCellAttrs,
  TableRowAttrs,
  TextBoxAttrs,
  TextColorAttrs,
  TextEffectAttrs,
  TrackedChangeMarkAttrs,
  UnderlineAttrs,
} from "../schema";

export type ProseMirrorAttrIssue = {
  path: string;
  message: string;
};

export type ReadProseMirrorAttrsResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: ProseMirrorAttrIssue[] };

const SECTION_BREAK_TYPES = [
  "nextPage",
  "continuous",
  "oddPage",
  "evenPage",
] as const satisfies readonly NonNullable<ParagraphAttrs["sectionBreakType"]>[];

const IMAGE_DISPLAY_MODES = [
  "inline",
  "float",
  "block",
] as const satisfies readonly NonNullable<ImageAttrs["displayMode"]>[];

const IMAGE_CSS_FLOATS = [
  "left",
  "right",
  "none",
] as const satisfies readonly NonNullable<ImageAttrs["cssFloat"]>[];

const FIELD_KINDS = [
  "simple",
  "complex",
] as const satisfies readonly FieldAttrs["fieldKind"][];

const MATH_DISPLAYS = [
  "inline",
  "block",
] as const satisfies readonly NonNullable<MathAttrs["display"]>[];

const SHAPE_FILL_TYPES = [
  "none",
  "solid",
  "gradient",
  "pattern",
  "picture",
] as const satisfies readonly NonNullable<ShapeAttrs["fillType"]>[];

const SHAPE_GRADIENT_TYPES = [
  "linear",
  "radial",
  "rectangular",
  "path",
] as const satisfies readonly NonNullable<ShapeAttrs["gradientType"]>[];

const SHAPE_OUTLINE_CAPS = [
  "flat",
  "round",
  "square",
] as const satisfies readonly NonNullable<ShapeAttrs["outlineCap"]>[];

const SHAPE_LINE_END_TYPES = [
  "none",
  "triangle",
  "stealth",
  "diamond",
  "oval",
  "arrow",
] as const satisfies readonly NonNullable<
  ShapeAttrs["outlineHeadEnd"]
>["type"][];

const SHAPE_LINE_END_SIZES = [
  "sm",
  "med",
  "lg",
] as const satisfies readonly NonNullable<
  ShapeAttrs["outlineHeadEnd"]
>["width"][];

const EMPHASIS_MARK_TYPES = [
  "dot",
  "comma",
  "circle",
  "underDot",
] as const satisfies readonly NonNullable<EmphasisMarkAttrs["type"]>[];

// eigenpal #424 (gap 11) — w:effect values minus the no-op "none" sentinel.
// The mark is only minted when there is an actual animation to round-trip.
const TEXT_EFFECT_NON_NONE_VALUES = TEXT_EFFECT_VALUES.filter(
  (value): value is TextEffectAttrs["effect"] => value !== "none",
);

const NOTE_TYPES = [
  "footnote",
  "endnote",
] as const satisfies readonly NonNullable<FootnoteRefAttrs["noteType"]>[];

const TEXT_BOX_DOCX_PLACEMENTS = [
  "standalone",
  "inlineWithPrevious",
] as const satisfies readonly NonNullable<TextBoxAttrs["_docxPlacement"]>[];

const TRACKED_CHANGE_MOVE_KINDS = [
  "moveTo",
  "moveFrom",
] as const satisfies readonly NonNullable<TrackedChangeMarkAttrs["moveKind"]>[];

const HARD_BREAK_TYPES = ["column"] as const satisfies readonly NonNullable<
  HardBreakAttrs["breakType"]
>[];

const RUN_FORMATTING_OVERRIDE_FALSE_KEYS = [
  "bold",
  "italic",
  "strike",
  "doubleStrike",
  "allCaps",
  "smallCaps",
  "hidden",
  "emboss",
  "imprint",
  "shadow",
  "outline",
] as const satisfies readonly (keyof RunFormattingOverrideAttrs)[];

const TEXT_FORMATTING_BOOLEAN_KEYS = [
  "bold",
  "boldCs",
  "italic",
  "italicCs",
  "strike",
  "doubleStrike",
  "smallCaps",
  "allCaps",
  "hidden",
  "emboss",
  "imprint",
  "shadow",
  "outline",
] as const;

const SECTION_ORIENTATIONS = ["portrait", "landscape"] as const;
const SECTION_START_TYPES = [
  "continuous",
  "nextPage",
  "oddPage",
  "evenPage",
  "nextColumn",
] as const;
const SECTION_VERTICAL_ALIGNMENTS = [
  "top",
  "center",
  "both",
  "bottom",
] as const;

const paragraphAttrsCache = new WeakMap<PMNode, ParagraphAttrs>();
const hardBreakAttrsCache = new WeakMap<PMNode, HardBreakAttrs>();
const tableAttrsCache = new WeakMap<PMNode, TableAttrs>();
const tableRowAttrsCache = new WeakMap<PMNode, TableRowAttrs>();
const tableCellAttrsCache = new WeakMap<PMNode, TableCellAttrs>();
const imageAttrsCache = new WeakMap<PMNode, ImageAttrs>();
const fieldAttrsCache = new WeakMap<PMNode, FieldAttrs>();
const mathAttrsCache = new WeakMap<PMNode, MathAttrs>();
const sdtAttrsCache = new WeakMap<PMNode, SdtAttrs>();
const shapeAttrsCache = new WeakMap<PMNode, ShapeAttrs>();
const textBoxAttrsCache = new WeakMap<PMNode, TextBoxAttrs>();

const underlineAttrsCache = new WeakMap<Mark, UnderlineAttrs>();
const strikeAttrsCache = new WeakMap<Mark, StrikeAttrs>();
const textColorAttrsCache = new WeakMap<Mark, TextColorAttrs>();
const highlightAttrsCache = new WeakMap<Mark, HighlightAttrs>();
const runShadingAttrsCache = new WeakMap<Mark, RunShadingAttrs>();
const fontSizeAttrsCache = new WeakMap<Mark, FontSizeAttrs>();
const fontFamilyAttrsCache = new WeakMap<Mark, FontFamilyAttrs>();
const characterSpacingAttrsCache = new WeakMap<Mark, CharacterSpacingAttrs>();
const characterStyleAttrsCache = new WeakMap<Mark, CharacterStyleAttrs>();
const emphasisMarkAttrsCache = new WeakMap<Mark, EmphasisMarkAttrs>();
const textEffectAttrsCache = new WeakMap<Mark, TextEffectAttrs>();
const footnoteRefAttrsCache = new WeakMap<Mark, FootnoteRefAttrs>();
const commentAttrsCache = new WeakMap<Mark, CommentAttrs>();
const trackedChangeAttrsCache = new WeakMap<Mark, TrackedChangeMarkAttrs>();
const runFormattingOverrideAttrsCache = new WeakMap<
  Mark,
  RunFormattingOverrideAttrs
>();
const hyperlinkAttrsCache = new WeakMap<Mark, HyperlinkAttrs>();

export const readParagraphAttrs = (
  node: PMNode,
): ReadProseMirrorAttrsResult<ParagraphAttrs> => {
  const attrs = attrsRecord(node.attrs);
  const issues: ProseMirrorAttrIssue[] = [];
  expectNodeType(node, "paragraph", issues);

  optionalString(attrs, "paraId", "paragraph.attrs.paraId", issues);
  optionalString(attrs, "textId", "paragraph.attrs.textId", issues);
  optionalOneOf(
    attrs,
    "alignment",
    "paragraph.attrs.alignment",
    issues,
    PARAGRAPH_ALIGNMENT_VALUES,
  );
  optionalString(attrs, "styleId", "paragraph.attrs.styleId", issues);
  optionalNumber(attrs, "spaceBefore", "paragraph.attrs.spaceBefore", issues);
  optionalNumber(attrs, "spaceAfter", "paragraph.attrs.spaceAfter", issues);
  optionalNumber(attrs, "lineSpacing", "paragraph.attrs.lineSpacing", issues);
  optionalOneOf(
    attrs,
    "lineSpacingRule",
    "paragraph.attrs.lineSpacingRule",
    issues,
    LINE_SPACING_RULE_VALUES,
  );
  optionalNumber(attrs, "indentLeft", "paragraph.attrs.indentLeft", issues);
  optionalNumber(attrs, "indentRight", "paragraph.attrs.indentRight", issues);
  optionalNumber(
    attrs,
    "indentFirstLine",
    "paragraph.attrs.indentFirstLine",
    issues,
  );
  optionalBoolean(
    attrs,
    "hangingIndent",
    "paragraph.attrs.hangingIndent",
    issues,
  );
  optionalNumber(attrs, "outlineLevel", "paragraph.attrs.outlineLevel", issues);
  optionalString(attrs, "listNumFmt", "paragraph.attrs.listNumFmt", issues);
  optionalBoolean(
    attrs,
    "listIsBullet",
    "paragraph.attrs.listIsBullet",
    issues,
  );
  optionalBoolean(attrs, "listIsLegal", "paragraph.attrs.listIsLegal", issues);
  optionalString(attrs, "listMarker", "paragraph.attrs.listMarker", issues);
  optionalBoolean(
    attrs,
    "listMarkerHidden",
    "paragraph.attrs.listMarkerHidden",
    issues,
  );
  optionalString(
    attrs,
    "listMarkerFontFamily",
    "paragraph.attrs.listMarkerFontFamily",
    issues,
  );
  optionalNumber(
    attrs,
    "listMarkerFontSize",
    "paragraph.attrs.listMarkerFontSize",
    issues,
  );
  optionalString(
    attrs,
    "listMarkerSuffix",
    "paragraph.attrs.listMarkerSuffix",
    issues,
  );
  optionalBoolean(
    attrs,
    "listMarkerAllCaps",
    "paragraph.attrs.listMarkerAllCaps",
    issues,
  );
  optionalNumber(
    attrs,
    "listImplicitChildLevelAdvances",
    "paragraph.attrs.listImplicitChildLevelAdvances",
    issues,
  );
  optionalNumber(
    attrs,
    "listMarkerSecondSlotOffsetTwips",
    "paragraph.attrs.listMarkerSecondSlotOffsetTwips",
    issues,
  );
  optionalNumber(
    attrs,
    "listStartOverride",
    "paragraph.attrs.listStartOverride",
    issues,
  );
  optionalBoolean(
    attrs,
    "pageBreakBefore",
    "paragraph.attrs.pageBreakBefore",
    issues,
  );
  optionalBoolean(
    attrs,
    "renderedPageBreakBefore",
    "paragraph.attrs.renderedPageBreakBefore",
    issues,
  );
  optionalBoolean(
    attrs,
    "runInWithNext",
    "paragraph.attrs.runInWithNext",
    issues,
  );
  optionalBoolean(attrs, "keepNext", "paragraph.attrs.keepNext", issues);
  optionalBoolean(attrs, "keepLines", "paragraph.attrs.keepLines", issues);
  optionalBoolean(
    attrs,
    "contextualSpacing",
    "paragraph.attrs.contextualSpacing",
    issues,
  );
  optionalBoolean(attrs, "bidi", "paragraph.attrs.bidi", issues);
  optionalOneOf(
    attrs,
    "sectionBreakType",
    "paragraph.attrs.sectionBreakType",
    issues,
    SECTION_BREAK_TYPES,
  );
  optionalStringArray(
    attrs,
    "listLevelNumFmts",
    "paragraph.attrs.listLevelNumFmts",
    issues,
  );
  optionalNumber(
    attrs,
    "listAbstractNumId",
    "paragraph.attrs.listAbstractNumId",
    issues,
  );
  optionalBorderMap(attrs, "borders", "paragraph.attrs.borders", issues, [
    "top",
    "bottom",
    "left",
    "right",
    "between",
    "bar",
  ]);
  optionalShading(attrs, "shading", "paragraph.attrs.shading", issues);
  optionalTabStops(attrs, "tabs", "paragraph.attrs.tabs", issues);
  optionalRecord(
    attrs,
    "spacingExplicit",
    "paragraph.attrs.spacingExplicit",
    issues,
  );
  optionalTextFormatting(
    attrs,
    "defaultTextFormatting",
    "paragraph.attrs.defaultTextFormatting",
    issues,
  );
  optionalRecord(attrs, "numPr", "paragraph.attrs.numPr", issues);
  validateNumPr(attrs["numPr"], issues);
  optionalBookmarkArray(attrs["bookmarks"], issues);
  optionalEmptyHyperlinkArray(attrs["_emptyHyperlinks"], issues);
  optionalSectionProperties(
    attrs,
    "_sectionProperties",
    "paragraph.attrs._sectionProperties",
    issues,
  );
  optionalPropertyChanges(
    attrs,
    "_propertyChanges",
    "paragraph.attrs._propertyChanges",
    issues,
    ["paragraphPropertyChange"],
  );

  return attrsResult(attrs, issues);
};

export const expectParagraphAttrs = (node: PMNode): ParagraphAttrs =>
  expectCachedNodeAttrs(
    node,
    paragraphAttrsCache,
    readParagraphAttrs,
    "paragraph attrs",
  );

export const readHardBreakAttrs = (
  node: PMNode,
): ReadProseMirrorAttrsResult<HardBreakAttrs> => {
  const attrs = attrsRecord(node.attrs);
  const issues: ProseMirrorAttrIssue[] = [];
  expectNodeType(node, "hardBreak", issues);

  optionalOneOf(
    attrs,
    "breakType",
    "hardBreak.attrs.breakType",
    issues,
    HARD_BREAK_TYPES,
  );

  return attrsResult(attrs, issues);
};

export const expectHardBreakAttrs = (node: PMNode): HardBreakAttrs =>
  expectCachedNodeAttrs(
    node,
    hardBreakAttrsCache,
    readHardBreakAttrs,
    "hard break attrs",
  );

export const readTableAttrs = (
  node: PMNode,
): ReadProseMirrorAttrsResult<TableAttrs> => {
  const attrs = attrsRecord(node.attrs);
  const issues: ProseMirrorAttrIssue[] = [];
  expectNodeType(node, "table", issues);

  optionalString(attrs, "styleId", "table.attrs.styleId", issues);
  optionalNumber(attrs, "width", "table.attrs.width", issues);
  optionalOneOf(
    attrs,
    "widthType",
    "table.attrs.widthType",
    issues,
    TABLE_WIDTH_TYPE_VALUES,
  );
  optionalOneOf(
    attrs,
    "justification",
    "table.attrs.justification",
    issues,
    TABLE_JUSTIFICATION_VALUES,
  );
  optionalNumberArray(
    attrs,
    "columnWidths",
    "table.attrs.columnWidths",
    issues,
  );
  optionalRecord(attrs, "floating", "table.attrs.floating", issues);
  optionalInsetMap(attrs, "cellMargins", "table.attrs.cellMargins", issues);
  optionalRecord(attrs, "look", "table.attrs.look", issues);
  optionalRecord(
    attrs,
    "_originalFormatting",
    "table.attrs._originalFormatting",
    issues,
  );

  return attrsResult(attrs, issues);
};

export const expectTableAttrs = (node: PMNode): TableAttrs =>
  expectCachedNodeAttrs(node, tableAttrsCache, readTableAttrs, "table attrs");

export const readTableRowAttrs = (
  node: PMNode,
): ReadProseMirrorAttrsResult<TableRowAttrs> => {
  const attrs = attrsRecord(node.attrs);
  const issues: ProseMirrorAttrIssue[] = [];
  expectNodeType(node, "tableRow", issues);

  optionalNumber(attrs, "height", "tableRow.attrs.height", issues);
  optionalOneOf(
    attrs,
    "heightRule",
    "tableRow.attrs.heightRule",
    issues,
    TABLE_ROW_HEIGHT_RULE_VALUES,
  );
  optionalBoolean(attrs, "isHeader", "tableRow.attrs.isHeader", issues);
  optionalRecord(
    attrs,
    "_originalFormatting",
    "tableRow.attrs._originalFormatting",
    issues,
  );

  return attrsResult(attrs, issues);
};

export const expectTableRowAttrs = (node: PMNode): TableRowAttrs =>
  expectCachedNodeAttrs(
    node,
    tableRowAttrsCache,
    readTableRowAttrs,
    "table row attrs",
  );

export const readTableCellAttrs = (
  node: PMNode,
): ReadProseMirrorAttrsResult<TableCellAttrs> => {
  const attrs = attrsRecord(node.attrs);
  const issues: ProseMirrorAttrIssue[] = [];
  expectNodeTypeOneOf(node, ["tableCell", "tableHeader"], issues);

  requiredNumber(attrs, "colspan", "tableCell.attrs.colspan", issues);
  requiredNumber(attrs, "rowspan", "tableCell.attrs.rowspan", issues);
  optionalNumberArray(attrs, "colwidth", "tableCell.attrs.colwidth", issues, {
    allowNull: true,
  });
  optionalNumber(attrs, "width", "tableCell.attrs.width", issues);
  optionalOneOf(
    attrs,
    "widthType",
    "tableCell.attrs.widthType",
    issues,
    TABLE_WIDTH_TYPE_VALUES,
  );
  optionalOneOf(
    attrs,
    "verticalAlign",
    "tableCell.attrs.verticalAlign",
    issues,
    TABLE_CELL_VERTICAL_ALIGNMENT_VALUES,
  );
  optionalString(
    attrs,
    "backgroundColor",
    "tableCell.attrs.backgroundColor",
    issues,
  );
  optionalOneOf(
    attrs,
    "textDirection",
    "tableCell.attrs.textDirection",
    issues,
    TABLE_CELL_TEXT_DIRECTION_VALUES,
  );
  optionalBoolean(attrs, "noWrap", "tableCell.attrs.noWrap", issues);
  optionalBorderMap(attrs, "borders", "tableCell.attrs.borders", issues, [
    "top",
    "bottom",
    "left",
    "right",
  ]);
  optionalInsetMap(attrs, "margins", "tableCell.attrs.margins", issues);
  optionalRecord(
    attrs,
    "_originalFormatting",
    "tableCell.attrs._originalFormatting",
    issues,
  );
  optionalBoolean(
    attrs,
    "_preserveVMergeRestart",
    "tableCell.attrs._preserveVMergeRestart",
    issues,
  );
  optionalArray(
    attrs,
    "_docxVMergeContinuationCells",
    "tableCell.attrs._docxVMergeContinuationCells",
    issues,
  );

  return attrsResult(attrs, issues);
};

export const expectTableCellAttrs = (node: PMNode): TableCellAttrs =>
  expectCachedNodeAttrs(
    node,
    tableCellAttrsCache,
    readTableCellAttrs,
    "table cell attrs",
  );

export const readImageAttrs = (
  node: PMNode,
): ReadProseMirrorAttrsResult<ImageAttrs> => {
  const attrs = attrsRecord(node.attrs);
  const issues: ProseMirrorAttrIssue[] = [];
  expectNodeType(node, "image", issues);

  requiredString(attrs, "src", "image.attrs.src", issues);
  optionalString(attrs, "alt", "image.attrs.alt", issues);
  optionalString(attrs, "title", "image.attrs.title", issues);
  optionalString(attrs, "rId", "image.attrs.rId", issues);
  optionalNumber(attrs, "width", "image.attrs.width", issues);
  optionalNumber(attrs, "height", "image.attrs.height", issues);
  optionalOneOf(
    attrs,
    "wrapType",
    "image.attrs.wrapType",
    issues,
    IMAGE_WRAP_TYPE_VALUES,
  );
  optionalOneOf(
    attrs,
    "displayMode",
    "image.attrs.displayMode",
    issues,
    IMAGE_DISPLAY_MODES,
  );
  optionalOneOf(
    attrs,
    "cssFloat",
    "image.attrs.cssFloat",
    issues,
    IMAGE_CSS_FLOATS,
  );
  optionalString(attrs, "transform", "image.attrs.transform", issues);
  optionalNumber(attrs, "distTop", "image.attrs.distTop", issues);
  optionalNumber(attrs, "distBottom", "image.attrs.distBottom", issues);
  optionalNumber(attrs, "distLeft", "image.attrs.distLeft", issues);
  optionalNumber(attrs, "distRight", "image.attrs.distRight", issues);
  optionalImagePosition(attrs, "position", "image.attrs.position", issues);
  optionalNumber(attrs, "borderWidth", "image.attrs.borderWidth", issues);
  optionalString(attrs, "borderColor", "image.attrs.borderColor", issues);
  optionalString(attrs, "borderStyle", "image.attrs.borderStyle", issues);
  optionalOneOf(
    attrs,
    "wrapText",
    "image.attrs.wrapText",
    issues,
    IMAGE_WRAP_TEXT_VALUES,
  );
  optionalString(attrs, "hlinkHref", "image.attrs.hlinkHref", issues);
  optionalString(attrs, "_docxRawXml", "image.attrs._docxRawXml", issues);

  return attrsResult(attrs, issues);
};

export const expectImageAttrs = (node: PMNode): ImageAttrs =>
  expectCachedNodeAttrs(node, imageAttrsCache, readImageAttrs, "image attrs");

export const readFieldAttrs = (
  node: PMNode,
): ReadProseMirrorAttrsResult<FieldAttrs> => {
  const attrs = attrsRecord(node.attrs);
  const issues: ProseMirrorAttrIssue[] = [];
  expectNodeType(node, "field", issues);

  requiredOneOf(
    attrs,
    "fieldType",
    "field.attrs.fieldType",
    issues,
    FIELD_TYPE_VALUES,
  );
  requiredString(attrs, "instruction", "field.attrs.instruction", issues);
  requiredString(attrs, "displayText", "field.attrs.displayText", issues);
  requiredOneOf(
    attrs,
    "fieldKind",
    "field.attrs.fieldKind",
    issues,
    FIELD_KINDS,
  );
  optionalBoolean(attrs, "fldLock", "field.attrs.fldLock", issues);
  optionalBoolean(attrs, "dirty", "field.attrs.dirty", issues);

  return attrsResult(attrs, issues);
};

export const expectFieldAttrs = (node: PMNode): FieldAttrs =>
  expectCachedNodeAttrs(node, fieldAttrsCache, readFieldAttrs, "field attrs");

export const readMathAttrs = (
  node: PMNode,
): ReadProseMirrorAttrsResult<MathAttrs> => {
  const attrs = attrsRecord(node.attrs);
  const issues: ProseMirrorAttrIssue[] = [];
  expectNodeType(node, "math", issues);

  optionalOneOf(attrs, "display", "math.attrs.display", issues, MATH_DISPLAYS);
  requiredString(attrs, "ommlXml", "math.attrs.ommlXml", issues);
  optionalString(attrs, "plainText", "math.attrs.plainText", issues);

  return attrsResult(attrs, issues);
};

export const expectMathAttrs = (node: PMNode): MathAttrs =>
  expectCachedNodeAttrs(node, mathAttrsCache, readMathAttrs, "math attrs");

export const readSdtAttrs = (
  node: PMNode,
): ReadProseMirrorAttrsResult<SdtAttrs> => {
  const attrs = attrsRecord(node.attrs);
  const issues: ProseMirrorAttrIssue[] = [];
  expectNodeType(node, "sdt", issues);

  requiredOneOf(attrs, "sdtType", "sdt.attrs.sdtType", issues, SDT_TYPE_VALUES);
  optionalString(attrs, "alias", "sdt.attrs.alias", issues);
  optionalString(attrs, "tag", "sdt.attrs.tag", issues);
  optionalOneOf(attrs, "lock", "sdt.attrs.lock", issues, SDT_LOCK_VALUES);
  optionalString(attrs, "placeholder", "sdt.attrs.placeholder", issues);
  optionalBoolean(
    attrs,
    "showingPlaceholder",
    "sdt.attrs.showingPlaceholder",
    issues,
  );
  optionalString(attrs, "dateFormat", "sdt.attrs.dateFormat", issues);
  optionalString(attrs, "dateValueISO", "sdt.attrs.dateValueISO", issues);
  optionalSdtListItems(attrs, "listItems", "sdt.attrs.listItems", issues);
  optionalString(
    attrs,
    "dropdownLastValue",
    "sdt.attrs.dropdownLastValue",
    issues,
  );
  optionalBoolean(attrs, "checked", "sdt.attrs.checked", issues);

  return attrsResult(attrs, issues);
};

export const expectSdtAttrs = (node: PMNode): SdtAttrs =>
  expectCachedNodeAttrs(node, sdtAttrsCache, readSdtAttrs, "sdt attrs");

const blockSdtAttrsCache = new WeakMap<PMNode, BlockSdtAttrs>();

export const readBlockSdtAttrs = (
  node: PMNode,
): ReadProseMirrorAttrsResult<BlockSdtAttrs> => {
  const attrs = attrsRecord(node.attrs);
  const issues: ProseMirrorAttrIssue[] = [];
  expectNodeType(node, "blockSdt", issues);

  requiredOneOf(
    attrs,
    "sdtType",
    "blockSdt.attrs.sdtType",
    issues,
    SDT_TYPE_VALUES,
  );
  optionalString(attrs, "alias", "blockSdt.attrs.alias", issues);
  optionalString(attrs, "tag", "blockSdt.attrs.tag", issues);
  optionalNumber(attrs, "id", "blockSdt.attrs.id", issues);
  optionalOneOf(attrs, "lock", "blockSdt.attrs.lock", issues, SDT_LOCK_VALUES);
  optionalString(attrs, "placeholder", "blockSdt.attrs.placeholder", issues);
  optionalBoolean(
    attrs,
    "showingPlaceholder",
    "blockSdt.attrs.showingPlaceholder",
    issues,
  );
  optionalString(attrs, "dateFormat", "blockSdt.attrs.dateFormat", issues);
  optionalString(attrs, "dateValueISO", "blockSdt.attrs.dateValueISO", issues);
  optionalSdtListItems(attrs, "listItems", "blockSdt.attrs.listItems", issues);
  optionalString(
    attrs,
    "dropdownLastValue",
    "blockSdt.attrs.dropdownLastValue",
    issues,
  );
  optionalBoolean(attrs, "checked", "blockSdt.attrs.checked", issues);
  optionalBoolean(
    attrs,
    "_originallyEmpty",
    "blockSdt.attrs._originallyEmpty",
    issues,
  );
  optionalString(
    attrs,
    "rawPropertiesXml",
    "blockSdt.attrs.rawPropertiesXml",
    issues,
  );
  optionalString(
    attrs,
    "rawEndPropertiesXml",
    "blockSdt.attrs.rawEndPropertiesXml",
    issues,
  );
  optionalString(
    attrs,
    "rawSdtChildrenBeforeContent",
    "blockSdt.attrs.rawSdtChildrenBeforeContent",
    issues,
  );
  optionalString(
    attrs,
    "rawSdtChildrenAfterContent",
    "blockSdt.attrs.rawSdtChildrenAfterContent",
    issues,
  );

  return attrsResult(attrs, issues);
};

export const expectBlockSdtAttrs = (node: PMNode): BlockSdtAttrs =>
  expectCachedNodeAttrs(
    node,
    blockSdtAttrsCache,
    readBlockSdtAttrs,
    "blockSdt attrs",
  );

export const readShapeAttrs = (
  node: PMNode,
): ReadProseMirrorAttrsResult<ShapeAttrs> => {
  const attrs = attrsRecord(node.attrs);
  const issues: ProseMirrorAttrIssue[] = [];
  expectNodeType(node, "shape", issues);

  optionalString(attrs, "shapeType", "shape.attrs.shapeType", issues);
  optionalString(attrs, "shapeId", "shape.attrs.shapeId", issues);
  optionalNumber(attrs, "width", "shape.attrs.width", issues);
  optionalNumber(attrs, "height", "shape.attrs.height", issues);
  optionalString(attrs, "fillColor", "shape.attrs.fillColor", issues);
  optionalOneOf(
    attrs,
    "fillType",
    "shape.attrs.fillType",
    issues,
    SHAPE_FILL_TYPES,
  );
  optionalOneOf(
    attrs,
    "gradientType",
    "shape.attrs.gradientType",
    issues,
    SHAPE_GRADIENT_TYPES,
  );
  optionalNumber(attrs, "gradientAngle", "shape.attrs.gradientAngle", issues);
  optionalGradientStops(
    attrs,
    "gradientStops",
    "shape.attrs.gradientStops",
    issues,
  );
  optionalNumber(attrs, "outlineWidth", "shape.attrs.outlineWidth", issues);
  optionalString(attrs, "outlineColor", "shape.attrs.outlineColor", issues);
  optionalOneOf(
    attrs,
    "outlineStyle",
    "shape.attrs.outlineStyle",
    issues,
    OUTLINE_STYLE_ATTR_VALUES,
  );
  optionalOneOf(
    attrs,
    "outlineCap",
    "shape.attrs.outlineCap",
    issues,
    SHAPE_OUTLINE_CAPS,
  );
  optionalShapeLineEnd(
    attrs,
    "outlineHeadEnd",
    "shape.attrs.outlineHeadEnd",
    issues,
  );
  optionalShapeLineEnd(
    attrs,
    "outlineTailEnd",
    "shape.attrs.outlineTailEnd",
    issues,
  );
  optionalString(attrs, "transform", "shape.attrs.transform", issues);
  optionalOneOf(
    attrs,
    "displayMode",
    "shape.attrs.displayMode",
    issues,
    IMAGE_DISPLAY_MODES,
  );
  optionalOneOf(
    attrs,
    "cssFloat",
    "shape.attrs.cssFloat",
    issues,
    IMAGE_CSS_FLOATS,
  );
  optionalOneOf(
    attrs,
    "wrapType",
    "shape.attrs.wrapType",
    issues,
    IMAGE_WRAP_TYPE_VALUES,
  );
  optionalOneOf(
    attrs,
    "wrapText",
    "shape.attrs.wrapText",
    issues,
    IMAGE_WRAP_TEXT_VALUES,
  );
  optionalNumber(attrs, "distTop", "shape.attrs.distTop", issues);
  optionalNumber(attrs, "distBottom", "shape.attrs.distBottom", issues);
  optionalNumber(attrs, "distLeft", "shape.attrs.distLeft", issues);
  optionalNumber(attrs, "distRight", "shape.attrs.distRight", issues);
  optionalImagePosition(attrs, "position", "shape.attrs.position", issues);
  optionalString(attrs, "shadowColor", "shape.attrs.shadowColor", issues);
  optionalNumber(attrs, "shadowBlur", "shape.attrs.shadowBlur", issues);
  optionalNumber(attrs, "shadowOffsetX", "shape.attrs.shadowOffsetX", issues);
  optionalNumber(attrs, "shadowOffsetY", "shape.attrs.shadowOffsetY", issues);
  optionalString(attrs, "glowColor", "shape.attrs.glowColor", issues);
  optionalNumber(attrs, "glowRadius", "shape.attrs.glowRadius", issues);

  return attrsResult(attrs, issues);
};

export const expectShapeAttrs = (node: PMNode): ShapeAttrs =>
  expectCachedNodeAttrs(node, shapeAttrsCache, readShapeAttrs, "shape attrs");

export const readTextBoxAttrs = (
  node: PMNode,
): ReadProseMirrorAttrsResult<TextBoxAttrs> => {
  const attrs = attrsRecord(node.attrs);
  const issues: ProseMirrorAttrIssue[] = [];
  expectNodeType(node, "textBox", issues);

  optionalNumber(attrs, "width", "textBox.attrs.width", issues);
  optionalNumber(attrs, "height", "textBox.attrs.height", issues);
  optionalString(attrs, "textBoxId", "textBox.attrs.textBoxId", issues);
  optionalString(attrs, "fillColor", "textBox.attrs.fillColor", issues);
  optionalNumber(attrs, "outlineWidth", "textBox.attrs.outlineWidth", issues);
  optionalString(attrs, "outlineColor", "textBox.attrs.outlineColor", issues);
  optionalOneOf(
    attrs,
    "outlineStyle",
    "textBox.attrs.outlineStyle",
    issues,
    OUTLINE_STYLE_ATTR_VALUES,
  );
  optionalNumber(attrs, "marginTop", "textBox.attrs.marginTop", issues);
  optionalNumber(attrs, "marginBottom", "textBox.attrs.marginBottom", issues);
  optionalNumber(attrs, "marginLeft", "textBox.attrs.marginLeft", issues);
  optionalNumber(attrs, "marginRight", "textBox.attrs.marginRight", issues);
  optionalString(attrs, "verticalAlign", "textBox.attrs.verticalAlign", issues);
  optionalOneOf(
    attrs,
    "displayMode",
    "textBox.attrs.displayMode",
    issues,
    IMAGE_DISPLAY_MODES,
  );
  optionalOneOf(
    attrs,
    "cssFloat",
    "textBox.attrs.cssFloat",
    issues,
    IMAGE_CSS_FLOATS,
  );
  optionalOneOf(
    attrs,
    "wrapType",
    "textBox.attrs.wrapType",
    issues,
    IMAGE_WRAP_TYPE_VALUES,
  );
  optionalOneOf(
    attrs,
    "wrapText",
    "textBox.attrs.wrapText",
    issues,
    IMAGE_WRAP_TEXT_VALUES,
  );
  optionalNumber(attrs, "distTop", "textBox.attrs.distTop", issues);
  optionalNumber(attrs, "distBottom", "textBox.attrs.distBottom", issues);
  optionalNumber(attrs, "distLeft", "textBox.attrs.distLeft", issues);
  optionalNumber(attrs, "distRight", "textBox.attrs.distRight", issues);
  optionalImagePosition(attrs, "position", "textBox.attrs.position", issues);
  optionalOneOf(
    attrs,
    "_docxPlacement",
    "textBox.attrs._docxPlacement",
    issues,
    TEXT_BOX_DOCX_PLACEMENTS,
  );
  optionalString(attrs, "_docxGroupId", "textBox.attrs._docxGroupId", issues);

  return attrsResult(attrs, issues);
};

export const expectTextBoxAttrs = (node: PMNode): TextBoxAttrs =>
  expectCachedNodeAttrs(
    node,
    textBoxAttrsCache,
    readTextBoxAttrs,
    "text box attrs",
  );

export const readUnderlineMarkAttrs = (
  mark: Mark,
): ReadProseMirrorAttrsResult<UnderlineAttrs> => {
  const attrs = attrsRecord(mark.attrs);
  const issues: ProseMirrorAttrIssue[] = [];
  expectMarkType(mark, "underline", issues);

  optionalOneOf(
    attrs,
    "style",
    "underline.attrs.style",
    issues,
    UNDERLINE_STYLE_VALUES,
  );
  optionalTextColor(attrs, "color", "underline.attrs.color", issues);

  return attrsResult(attrs, issues);
};

export const expectUnderlineMarkAttrs = (mark: Mark): UnderlineAttrs =>
  expectCachedMarkAttrs(
    mark,
    underlineAttrsCache,
    readUnderlineMarkAttrs,
    "underline attrs",
  );

export const readStrikeMarkAttrs = (
  mark: Mark,
): ReadProseMirrorAttrsResult<StrikeAttrs> => {
  const attrs = attrsRecord(mark.attrs);
  const issues: ProseMirrorAttrIssue[] = [];
  expectMarkType(mark, "strike", issues);

  optionalBoolean(attrs, "double", "strike.attrs.double", issues);

  return attrsResult(attrs, issues);
};

export const expectStrikeMarkAttrs = (mark: Mark): StrikeAttrs =>
  expectCachedMarkAttrs(
    mark,
    strikeAttrsCache,
    readStrikeMarkAttrs,
    "strike attrs",
  );

export const readTextColorMarkAttrs = (
  mark: Mark,
): ReadProseMirrorAttrsResult<TextColorAttrs> => {
  const attrs = attrsRecord(mark.attrs);
  const issues: ProseMirrorAttrIssue[] = [];
  expectMarkType(mark, "textColor", issues);

  optionalTextColorFields(attrs, "textColor.attrs", issues);

  return attrsResult(attrs, issues);
};

export const expectTextColorMarkAttrs = (mark: Mark): TextColorAttrs =>
  expectCachedMarkAttrs(
    mark,
    textColorAttrsCache,
    readTextColorMarkAttrs,
    "text color attrs",
  );

export const readHighlightMarkAttrs = (
  mark: Mark,
): ReadProseMirrorAttrsResult<HighlightAttrs> => {
  const attrs = attrsRecord(mark.attrs);
  const issues: ProseMirrorAttrIssue[] = [];
  expectMarkType(mark, "highlight", issues);

  requiredOneOf(
    attrs,
    "color",
    "highlight.attrs.color",
    issues,
    HIGHLIGHT_COLOR_VALUES,
  );

  return attrsResult(attrs, issues);
};

export const expectHighlightMarkAttrs = (mark: Mark): HighlightAttrs =>
  expectCachedMarkAttrs(
    mark,
    highlightAttrsCache,
    readHighlightMarkAttrs,
    "highlight attrs",
  );

export const readRunShadingMarkAttrs = (
  mark: Mark,
): ReadProseMirrorAttrsResult<RunShadingAttrs> => {
  const attrs = attrsRecord(mark.attrs);
  const issues: ProseMirrorAttrIssue[] = [];
  expectMarkType(mark, "runShading", issues);

  // Fill color (flattened ColorValue, same shape as textColor).
  optionalTextColorFields(attrs, "runShading.attrs", issues);
  optionalOneOf(
    attrs,
    "pattern",
    "runShading.attrs.pattern",
    issues,
    SHADING_PATTERN_VALUES,
  );
  optionalString(
    attrs,
    "patternColor",
    "runShading.attrs.patternColor",
    issues,
  );

  return attrsResult(attrs, issues);
};

export const expectRunShadingMarkAttrs = (mark: Mark): RunShadingAttrs =>
  expectCachedMarkAttrs(
    mark,
    runShadingAttrsCache,
    readRunShadingMarkAttrs,
    "run shading attrs",
  );

export const readCharacterStyleMarkAttrs = (
  mark: Mark,
): ReadProseMirrorAttrsResult<CharacterStyleAttrs> => {
  const attrs = attrsRecord(mark.attrs);
  const issues: ProseMirrorAttrIssue[] = [];
  expectMarkType(mark, "characterStyle", issues);

  requiredString(attrs, "styleId", "characterStyle.attrs.styleId", issues);
  optionalRecord(attrs, "_styleRPr", "characterStyle.attrs._styleRPr", issues);

  return attrsResult(attrs, issues);
};

export const expectCharacterStyleMarkAttrs = (
  mark: Mark,
): CharacterStyleAttrs =>
  expectCachedMarkAttrs(
    mark,
    characterStyleAttrsCache,
    readCharacterStyleMarkAttrs,
    "character style attrs",
  );

export const readFontSizeMarkAttrs = (
  mark: Mark,
): ReadProseMirrorAttrsResult<FontSizeAttrs> => {
  const attrs = attrsRecord(mark.attrs);
  const issues: ProseMirrorAttrIssue[] = [];
  expectMarkType(mark, "fontSize", issues);

  requiredNumber(attrs, "size", "fontSize.attrs.size", issues);

  return attrsResult(attrs, issues);
};

export const expectFontSizeMarkAttrs = (mark: Mark): FontSizeAttrs =>
  expectCachedMarkAttrs(
    mark,
    fontSizeAttrsCache,
    readFontSizeMarkAttrs,
    "font size attrs",
  );

export const readFontFamilyMarkAttrs = (
  mark: Mark,
): ReadProseMirrorAttrsResult<FontFamilyAttrs> => {
  const attrs = attrsRecord(mark.attrs);
  const issues: ProseMirrorAttrIssue[] = [];
  expectMarkType(mark, "fontFamily", issues);

  optionalString(attrs, "ascii", "fontFamily.attrs.ascii", issues);
  optionalString(attrs, "hAnsi", "fontFamily.attrs.hAnsi", issues);
  optionalString(attrs, "eastAsia", "fontFamily.attrs.eastAsia", issues);
  optionalString(attrs, "cs", "fontFamily.attrs.cs", issues);
  optionalString(attrs, "asciiTheme", "fontFamily.attrs.asciiTheme", issues);
  optionalString(attrs, "hAnsiTheme", "fontFamily.attrs.hAnsiTheme", issues);
  optionalString(
    attrs,
    "eastAsiaTheme",
    "fontFamily.attrs.eastAsiaTheme",
    issues,
  );
  optionalString(attrs, "csTheme", "fontFamily.attrs.csTheme", issues);

  return attrsResult(attrs, issues);
};

export const expectFontFamilyMarkAttrs = (mark: Mark): FontFamilyAttrs =>
  expectCachedMarkAttrs(
    mark,
    fontFamilyAttrsCache,
    readFontFamilyMarkAttrs,
    "font family attrs",
  );

export const readCharacterSpacingMarkAttrs = (
  mark: Mark,
): ReadProseMirrorAttrsResult<CharacterSpacingAttrs> => {
  const attrs = attrsRecord(mark.attrs);
  const issues: ProseMirrorAttrIssue[] = [];
  expectMarkType(mark, "characterSpacing", issues);

  optionalNumber(attrs, "spacing", "characterSpacing.attrs.spacing", issues);
  optionalNumber(attrs, "position", "characterSpacing.attrs.position", issues);
  optionalNumber(attrs, "scale", "characterSpacing.attrs.scale", issues);
  optionalNumber(attrs, "kerning", "characterSpacing.attrs.kerning", issues);

  return attrsResult(attrs, issues);
};

export const expectCharacterSpacingMarkAttrs = (
  mark: Mark,
): CharacterSpacingAttrs =>
  expectCachedMarkAttrs(
    mark,
    characterSpacingAttrsCache,
    readCharacterSpacingMarkAttrs,
    "character spacing attrs",
  );

export const readEmphasisMarkAttrs = (
  mark: Mark,
): ReadProseMirrorAttrsResult<EmphasisMarkAttrs> => {
  const attrs = attrsRecord(mark.attrs);
  const issues: ProseMirrorAttrIssue[] = [];
  expectMarkType(mark, "emphasisMark", issues);

  optionalOneOf(
    attrs,
    "type",
    "emphasisMark.attrs.type",
    issues,
    EMPHASIS_MARK_TYPES,
  );

  return attrsResult(attrs, issues);
};

export const expectEmphasisMarkAttrs = (mark: Mark): EmphasisMarkAttrs =>
  expectCachedMarkAttrs(
    mark,
    emphasisMarkAttrsCache,
    readEmphasisMarkAttrs,
    "emphasis mark attrs",
  );

export const readTextEffectMarkAttrs = (
  mark: Mark,
): ReadProseMirrorAttrsResult<TextEffectAttrs> => {
  const attrs = attrsRecord(mark.attrs);
  const issues: ProseMirrorAttrIssue[] = [];
  expectMarkType(mark, "textEffect", issues);

  requiredOneOf(
    attrs,
    "effect",
    "textEffect.attrs.effect",
    issues,
    TEXT_EFFECT_NON_NONE_VALUES,
  );

  return attrsResult(attrs, issues);
};

export const expectTextEffectMarkAttrs = (mark: Mark): TextEffectAttrs =>
  expectCachedMarkAttrs(
    mark,
    textEffectAttrsCache,
    readTextEffectMarkAttrs,
    "text effect attrs",
  );

export const readFootnoteRefMarkAttrs = (
  mark: Mark,
): ReadProseMirrorAttrsResult<FootnoteRefAttrs> => {
  const attrs = attrsRecord(mark.attrs);
  const issues: ProseMirrorAttrIssue[] = [];
  expectMarkType(mark, "footnoteRef", issues);

  requiredStringOrNumber(attrs, "id", "footnoteRef.attrs.id", issues);
  optionalOneOf(
    attrs,
    "noteType",
    "footnoteRef.attrs.noteType",
    issues,
    NOTE_TYPES,
  );

  return attrsResult(attrs, issues);
};

export const expectFootnoteRefMarkAttrs = (mark: Mark): FootnoteRefAttrs =>
  expectCachedMarkAttrs(
    mark,
    footnoteRefAttrsCache,
    readFootnoteRefMarkAttrs,
    "footnote reference attrs",
  );

export const readCommentMarkAttrs = (
  mark: Mark,
): ReadProseMirrorAttrsResult<CommentAttrs> => {
  const attrs = attrsRecord(mark.attrs);
  const issues: ProseMirrorAttrIssue[] = [];
  expectMarkType(mark, "comment", issues);

  requiredNumber(attrs, "commentId", "comment.attrs.commentId", issues);

  return attrsResult(attrs, issues);
};

export const expectCommentMarkAttrs = (mark: Mark): CommentAttrs =>
  expectCachedMarkAttrs(
    mark,
    commentAttrsCache,
    readCommentMarkAttrs,
    "comment attrs",
  );

export const readTrackedChangeMarkAttrs = (
  mark: Mark,
): ReadProseMirrorAttrsResult<TrackedChangeMarkAttrs> => {
  const attrs = attrsRecord(mark.attrs);
  const issues: ProseMirrorAttrIssue[] = [];
  expectMarkTypeOneOf(mark, ["insertion", "deletion"], issues);

  requiredNumber(
    attrs,
    "revisionId",
    `${mark.type.name}.attrs.revisionId`,
    issues,
  );
  requiredString(attrs, "author", `${mark.type.name}.attrs.author`, issues);
  optionalString(attrs, "date", `${mark.type.name}.attrs.date`, issues);
  optionalOneOf(
    attrs,
    "moveKind",
    `${mark.type.name}.attrs.moveKind`,
    issues,
    TRACKED_CHANGE_MOVE_KINDS,
  );

  return attrsResult(attrs, issues);
};

export const expectTrackedChangeMarkAttrs = (
  mark: Mark,
): TrackedChangeMarkAttrs =>
  expectCachedMarkAttrs(
    mark,
    trackedChangeAttrsCache,
    readTrackedChangeMarkAttrs,
    "tracked change attrs",
  );

export const readRunFormattingOverrideMarkAttrs = (
  mark: Mark,
): ReadProseMirrorAttrsResult<RunFormattingOverrideAttrs> => {
  const attrs = attrsRecord(mark.attrs);
  const issues: ProseMirrorAttrIssue[] = [];
  expectMarkType(mark, "runFormattingOverride", issues);

  for (const key of RUN_FORMATTING_OVERRIDE_FALSE_KEYS) {
    optionalFalse(attrs, key, `runFormattingOverride.attrs.${key}`, issues);
  }
  optionalOneOf(
    attrs,
    "underline",
    "runFormattingOverride.attrs.underline",
    issues,
    ["none"],
  );

  return attrsResult(attrs, issues);
};

export const expectRunFormattingOverrideMarkAttrs = (
  mark: Mark,
): RunFormattingOverrideAttrs =>
  expectCachedMarkAttrs(
    mark,
    runFormattingOverrideAttrsCache,
    readRunFormattingOverrideMarkAttrs,
    "run formatting override attrs",
  );

export const readHyperlinkMarkAttrs = (
  mark: Mark,
): ReadProseMirrorAttrsResult<HyperlinkAttrs> => {
  const attrs = attrsRecord(mark.attrs);
  const issues: ProseMirrorAttrIssue[] = [];
  expectMarkType(mark, "hyperlink", issues);

  requiredString(attrs, "href", "hyperlink.attrs.href", issues);
  optionalString(attrs, "tooltip", "hyperlink.attrs.tooltip", issues);
  optionalString(attrs, "rId", "hyperlink.attrs.rId", issues);
  validateNonNegativeInteger(
    attrs["_docxHyperlinkIndex"],
    "hyperlink.attrs._docxHyperlinkIndex",
    issues,
  );

  return attrsResult(attrs, issues);
};

export const expectHyperlinkMarkAttrs = (mark: Mark): HyperlinkAttrs =>
  expectCachedMarkAttrs(
    mark,
    hyperlinkAttrsCache,
    readHyperlinkMarkAttrs,
    "hyperlink attrs",
  );

type NodeAttrReader<T extends object> = (
  node: PMNode,
) => ReadProseMirrorAttrsResult<T>;

type NodeAttrPatch<T extends object> = {
  [K in keyof T]?: T[K] | undefined;
};

const mergeNodeAttrs = <T extends object>(
  node: PMNode,
  readAttrs: NodeAttrReader<T>,
  label: string,
  patch: NodeAttrPatch<T>,
): T => {
  const currentAttrs = expectAttrs(readAttrs(node), label);
  const mergedAttrs: Record<string, unknown> = { ...currentAttrs, ...patch };
  const nextAttrs: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(mergedAttrs)) {
    if (value !== undefined) {
      nextAttrs[key] = value;
    }
  }

  // SAFETY: `currentAttrs` has been validated by the node-specific reader, and
  // `patch` is typed against the same attr shape. Undefined patch values are
  // treated as deletions so ProseMirror can restore schema defaults.
  return nextAttrs as T;
};

export const mergeImageAttrs = (
  node: PMNode,
  patch: NodeAttrPatch<ImageAttrs>,
): ImageAttrs => mergeNodeAttrs(node, readImageAttrs, "image attrs", patch);

export const mergeParagraphAttrs = (
  node: PMNode,
  patch: NodeAttrPatch<ParagraphAttrs>,
): ParagraphAttrs =>
  mergeNodeAttrs(node, readParagraphAttrs, "paragraph attrs", patch);

export const mergeTableAttrs = (
  node: PMNode,
  patch: NodeAttrPatch<TableAttrs>,
): TableAttrs => mergeNodeAttrs(node, readTableAttrs, "table attrs", patch);

export const mergeTableRowAttrs = (
  node: PMNode,
  patch: NodeAttrPatch<TableRowAttrs>,
): TableRowAttrs =>
  mergeNodeAttrs(node, readTableRowAttrs, "table row attrs", patch);

export const mergeTableCellAttrs = (
  node: PMNode,
  patch: NodeAttrPatch<TableCellAttrs>,
): TableCellAttrs =>
  mergeNodeAttrs(node, readTableCellAttrs, "table cell attrs", patch);

const attrsRecord = (attrs: unknown): Record<string, unknown> => {
  if (isRecord(attrs)) {
    return attrs;
  }

  return {};
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const attrsResult = <T>(
  attrs: Record<string, unknown>,
  issues: ProseMirrorAttrIssue[],
): ReadProseMirrorAttrsResult<T> => {
  if (issues.length > 0) {
    return { ok: false, issues };
  }

  const normalizedAttrs: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== null) {
      normalizedAttrs[key] = value;
    }
  }

  // SAFETY: this module is the ProseMirror FFI boundary. The checks above
  // validate the attrs this code relies on before exposing the typed shape,
  // and null ProseMirror defaults are normalized to absent optional fields.
  return { ok: true, value: normalizedAttrs as T };
};

const expectAttrs = <T>(
  result: ReadProseMirrorAttrsResult<T>,
  label: string,
): T => {
  if (result.ok) {
    return result.value;
  }

  const details = result.issues
    .map((issue) => `${issue.path}: ${issue.message}`)
    .join("\n");
  panic(`Invalid ProseMirror ${label}:\n${details}`);
};

function expectCachedNodeAttrs<T extends object>(
  node: PMNode,
  cache: WeakMap<PMNode, T>,
  reader: (node: PMNode) => ReadProseMirrorAttrsResult<T>,
  label: string,
): T {
  const cached = cache.get(node);
  if (cached) {
    return cached;
  }

  const value = expectAttrs(reader(node), label);
  cache.set(node, value);
  return value;
}

function expectCachedMarkAttrs<T extends object>(
  mark: Mark,
  cache: WeakMap<Mark, T>,
  reader: (mark: Mark) => ReadProseMirrorAttrsResult<T>,
  label: string,
): T {
  const cached = cache.get(mark);
  if (cached) {
    return cached;
  }

  const value = expectAttrs(reader(mark), label);
  cache.set(mark, value);
  return value;
}

const expectNodeType = (
  node: PMNode,
  expected: string,
  issues: ProseMirrorAttrIssue[],
): void => {
  if (node.type.name !== expected) {
    issues.push({
      path: "node.type.name",
      message: `Expected ${expected}, got ${node.type.name}.`,
    });
  }
};

const expectNodeTypeOneOf = (
  node: PMNode,
  expected: readonly string[],
  issues: ProseMirrorAttrIssue[],
): void => {
  if (!expected.includes(node.type.name)) {
    issues.push({
      path: "node.type.name",
      message: `Expected one of ${expected.join(", ")}, got ${node.type.name}.`,
    });
  }
};

const expectMarkType = (
  mark: Mark,
  expected: string,
  issues: ProseMirrorAttrIssue[],
): void => {
  if (mark.type.name !== expected) {
    issues.push({
      path: "mark.type.name",
      message: `Expected ${expected}, got ${mark.type.name}.`,
    });
  }
};

const expectMarkTypeOneOf = (
  mark: Mark,
  expected: readonly string[],
  issues: ProseMirrorAttrIssue[],
): void => {
  if (!expected.includes(mark.type.name)) {
    issues.push({
      path: "mark.type.name",
      message: `Expected one of ${expected.join(", ")}, got ${mark.type.name}.`,
    });
  }
};

const requiredString = (
  attrs: Record<string, unknown>,
  key: string,
  path: string,
  issues: ProseMirrorAttrIssue[],
): void => {
  if (typeof attrs[key] !== "string") {
    issues.push({ path, message: "Expected a string." });
  }
};

const requiredStringOrNumber = (
  attrs: Record<string, unknown>,
  key: string,
  path: string,
  issues: ProseMirrorAttrIssue[],
): void => {
  const value = attrs[key];
  if (typeof value !== "string" && typeof value !== "number") {
    issues.push({ path, message: "Expected a string or number." });
  }
};

const optionalString = (
  attrs: Record<string, unknown>,
  key: string,
  path: string,
  issues: ProseMirrorAttrIssue[],
): void => {
  const value = attrs[key];
  if (value !== undefined && value !== null && typeof value !== "string") {
    issues.push({ path, message: "Expected a string." });
  }
};

const optionalSdtListItems = (
  attrs: Record<string, unknown>,
  key: string,
  path: string,
  issues: ProseMirrorAttrIssue[],
): void => {
  const value = attrs[key];
  if (value === undefined || value === null) {
    return;
  }

  if (typeof value !== "string") {
    issues.push({ path, message: "Expected a JSON string." });
    return;
  }

  const parsed = parseJson(value, path, issues);
  if (!parsed.ok) {
    return;
  }

  if (!Array.isArray(parsed.value)) {
    issues.push({ path, message: "Expected a JSON array." });
    return;
  }

  for (const [index, item] of parsed.value.entries()) {
    if (!isRecord(item)) {
      issues.push({
        path: `${path}[${index}]`,
        message: "Expected a list item object.",
      });
      continue;
    }
    if (typeof item["displayText"] !== "string") {
      issues.push({
        path: `${path}[${index}].displayText`,
        message: "Expected a string.",
      });
    }
    if (typeof item["value"] !== "string") {
      issues.push({
        path: `${path}[${index}].value`,
        message: "Expected a string.",
      });
    }
  }
};

const optionalGradientStops = (
  attrs: Record<string, unknown>,
  key: string,
  path: string,
  issues: ProseMirrorAttrIssue[],
): void => {
  const value = attrs[key];
  if (value === undefined || value === null) {
    return;
  }

  if (typeof value !== "string") {
    issues.push({ path, message: "Expected a JSON string." });
    return;
  }

  const parsed = parseJson(value, path, issues);
  if (!parsed.ok) {
    return;
  }

  if (!Array.isArray(parsed.value)) {
    issues.push({ path, message: "Expected a JSON array." });
    return;
  }

  for (const [index, item] of parsed.value.entries()) {
    if (!isRecord(item)) {
      issues.push({
        path: `${path}[${index}]`,
        message: "Expected a gradient stop object.",
      });
      continue;
    }
    if (typeof item["position"] !== "number") {
      issues.push({
        path: `${path}[${index}].position`,
        message: "Expected a number.",
      });
    }
    if (typeof item["color"] !== "string") {
      issues.push({
        path: `${path}[${index}].color`,
        message: "Expected a string.",
      });
    }
  }
};

const parseJson = (
  value: string,
  path: string,
  issues: ProseMirrorAttrIssue[],
): { ok: true; value: unknown } | { ok: false } => {
  try {
    return { ok: true, value: JSON.parse(value) as unknown };
  } catch {
    issues.push({ path, message: "Expected valid JSON." });
    return { ok: false };
  }
};

const optionalFalse = (
  attrs: Record<string, unknown>,
  key: string,
  path: string,
  issues: ProseMirrorAttrIssue[],
): void => {
  const value = attrs[key];
  if (value !== undefined && value !== null && value !== false) {
    issues.push({ path, message: "Expected false." });
  }
};

const optionalOneOf = (
  attrs: Record<string, unknown>,
  key: string,
  path: string,
  issues: ProseMirrorAttrIssue[],
  allowed: readonly string[],
): void => {
  const value = attrs[key];
  if (value === undefined || value === null) {
    return;
  }

  if (typeof value !== "string") {
    issues.push({ path, message: "Expected a string." });
    return;
  }

  if (!allowed.includes(value)) {
    issues.push({
      path,
      message: `Expected one of ${allowed.join(", ")}.`,
    });
  }
};

const optionalShapeLineEnd = (
  attrs: Record<string, unknown>,
  key: string,
  path: string,
  issues: ProseMirrorAttrIssue[],
): void => {
  const value = attrs[key];
  if (value === undefined || value === null) {
    return;
  }

  if (!isRecord(value)) {
    issues.push({ path, message: "Expected an object." });
    return;
  }

  optionalOneOf(value, "type", `${path}.type`, issues, SHAPE_LINE_END_TYPES);
  optionalOneOf(value, "width", `${path}.width`, issues, SHAPE_LINE_END_SIZES);
  optionalOneOf(
    value,
    "length",
    `${path}.length`,
    issues,
    SHAPE_LINE_END_SIZES,
  );
};

const requiredOneOf = (
  attrs: Record<string, unknown>,
  key: string,
  path: string,
  issues: ProseMirrorAttrIssue[],
  allowed: readonly string[],
): void => {
  const value = attrs[key];
  if (typeof value !== "string") {
    issues.push({ path, message: "Expected a string." });
    return;
  }

  if (!allowed.includes(value)) {
    issues.push({
      path,
      message: `Expected one of ${allowed.join(", ")}.`,
    });
  }
};

const optionalTextColor = (
  attrs: Record<string, unknown>,
  key: string,
  path: string,
  issues: ProseMirrorAttrIssue[],
): void => {
  const value = attrs[key];
  if (value === undefined || value === null) {
    return;
  }

  if (!isRecord(value)) {
    issues.push({ path, message: "Expected an object." });
    return;
  }

  optionalTextColorFields(value, path, issues);
};

const optionalTextColorFields = (
  attrs: Record<string, unknown>,
  path: string,
  issues: ProseMirrorAttrIssue[],
): void => {
  optionalString(attrs, "rgb", `${path}.rgb`, issues);
  optionalOneOf(
    attrs,
    "themeColor",
    `${path}.themeColor`,
    issues,
    THEME_COLOR_SLOT_VALUES,
  );
  optionalString(attrs, "themeTint", `${path}.themeTint`, issues);
  optionalString(attrs, "themeShade", `${path}.themeShade`, issues);
};

const requiredNumber = (
  attrs: Record<string, unknown>,
  key: string,
  path: string,
  issues: ProseMirrorAttrIssue[],
): void => {
  if (typeof attrs[key] !== "number") {
    issues.push({ path, message: "Expected a number." });
  }
};

const optionalNumber = (
  attrs: Record<string, unknown>,
  key: string,
  path: string,
  issues: ProseMirrorAttrIssue[],
): void => {
  const value = attrs[key];
  if (value !== undefined && value !== null && typeof value !== "number") {
    issues.push({ path, message: "Expected a number." });
  }
};

const optionalBoolean = (
  attrs: Record<string, unknown>,
  key: string,
  path: string,
  issues: ProseMirrorAttrIssue[],
): void => {
  const value = attrs[key];
  if (value !== undefined && value !== null && typeof value !== "boolean") {
    issues.push({ path, message: "Expected a boolean." });
  }
};

const optionalRecord = (
  attrs: Record<string, unknown>,
  key: string,
  path: string,
  issues: ProseMirrorAttrIssue[],
): void => {
  const value = attrs[key];
  if (value !== undefined && value !== null && !isRecord(value)) {
    issues.push({ path, message: "Expected an object." });
  }
};

const optionalArray = (
  attrs: Record<string, unknown>,
  key: string,
  path: string,
  issues: ProseMirrorAttrIssue[],
): void => {
  const value = attrs[key];
  if (value !== undefined && value !== null && !Array.isArray(value)) {
    issues.push({ path, message: "Expected an array." });
  }
};

const optionalBorderMap = (
  attrs: Record<string, unknown>,
  key: string,
  path: string,
  issues: ProseMirrorAttrIssue[],
  sides: readonly string[],
): void => {
  const value = attrs[key];
  if (value === undefined || value === null) {
    return;
  }
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected an object." });
    return;
  }

  for (const side of sides) {
    validateBorderSpec(value[side], `${path}.${side}`, issues);
  }
};

const validateBorderSpec = (
  value: unknown,
  path: string,
  issues: ProseMirrorAttrIssue[],
): void => {
  if (value === undefined || value === null) {
    return;
  }
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected an object." });
    return;
  }

  optionalString(value, "style", `${path}.style`, issues);
  optionalNumber(value, "size", `${path}.size`, issues);
  optionalNumber(value, "space", `${path}.space`, issues);
  optionalBoolean(value, "shadow", `${path}.shadow`, issues);
  optionalBoolean(value, "frame", `${path}.frame`, issues);
  optionalColorValue(value, "color", `${path}.color`, issues);
};

const optionalColorValue = (
  attrs: Record<string, unknown>,
  key: string,
  path: string,
  issues: ProseMirrorAttrIssue[],
): void => {
  const value = attrs[key];
  if (value === undefined || value === null) {
    return;
  }
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected an object." });
    return;
  }

  optionalString(value, "rgb", `${path}.rgb`, issues);
  optionalBoolean(value, "auto", `${path}.auto`, issues);
  optionalOneOf(
    value,
    "themeColor",
    `${path}.themeColor`,
    issues,
    THEME_COLOR_SLOT_VALUES,
  );
  optionalString(value, "themeTint", `${path}.themeTint`, issues);
  optionalString(value, "themeShade", `${path}.themeShade`, issues);
};

const optionalShading = (
  attrs: Record<string, unknown>,
  key: string,
  path: string,
  issues: ProseMirrorAttrIssue[],
): void => {
  const value = attrs[key];
  if (value === undefined || value === null) {
    return;
  }
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected an object." });
    return;
  }

  optionalColorValue(value, "color", `${path}.color`, issues);
  optionalColorValue(value, "fill", `${path}.fill`, issues);
  optionalOneOf(
    value,
    "pattern",
    `${path}.pattern`,
    issues,
    SHADING_PATTERN_VALUES,
  );
};

const optionalTabStops = (
  attrs: Record<string, unknown>,
  key: string,
  path: string,
  issues: ProseMirrorAttrIssue[],
): void => {
  const value = attrs[key];
  if (value === undefined || value === null) {
    return;
  }
  if (!Array.isArray(value)) {
    issues.push({ path, message: "Expected an array." });
    return;
  }

  for (const [index, item] of value.entries()) {
    const itemPath = `${path}[${index}]`;
    if (!isRecord(item)) {
      issues.push({ path: itemPath, message: "Expected an object." });
      continue;
    }
    requiredNumber(item, "position", `${itemPath}.position`, issues);
    requiredOneOf(
      item,
      "alignment",
      `${itemPath}.alignment`,
      issues,
      TAB_STOP_ALIGNMENT_VALUES,
    );
    optionalOneOf(
      item,
      "leader",
      `${itemPath}.leader`,
      issues,
      TAB_LEADER_VALUES,
    );
  }
};

const optionalTextFormatting = (
  attrs: Record<string, unknown>,
  key: string,
  path: string,
  issues: ProseMirrorAttrIssue[],
): void => {
  const value = attrs[key];
  if (value === undefined || value === null) {
    return;
  }
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected an object." });
    return;
  }

  for (const booleanKey of TEXT_FORMATTING_BOOLEAN_KEYS) {
    optionalBoolean(value, booleanKey, `${path}.${booleanKey}`, issues);
  }
  optionalNumber(value, "fontSize", `${path}.fontSize`, issues);
  optionalNumber(value, "fontSizeCs", `${path}.fontSizeCs`, issues);
  optionalOneOf(
    value,
    "highlight",
    `${path}.highlight`,
    issues,
    HIGHLIGHT_COLOR_VALUES,
  );
  optionalColorValue(value, "color", `${path}.color`, issues);
  optionalShading(value, "shading", `${path}.shading`, issues);

  const underline = value["underline"];
  if (underline !== undefined && underline !== null) {
    if (!isRecord(underline)) {
      issues.push({
        path: `${path}.underline`,
        message: "Expected an object.",
      });
    } else {
      requiredOneOf(
        underline,
        "style",
        `${path}.underline.style`,
        issues,
        UNDERLINE_STYLE_VALUES,
      );
      optionalColorValue(underline, "color", `${path}.underline.color`, issues);
    }
  }
};

const optionalInsetMap = (
  attrs: Record<string, unknown>,
  key: string,
  path: string,
  issues: ProseMirrorAttrIssue[],
): void => {
  const value = attrs[key];
  if (value === undefined || value === null) {
    return;
  }
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected an object." });
    return;
  }

  optionalNumber(value, "top", `${path}.top`, issues);
  optionalNumber(value, "bottom", `${path}.bottom`, issues);
  optionalNumber(value, "left", `${path}.left`, issues);
  optionalNumber(value, "right", `${path}.right`, issues);
};

const optionalSectionProperties = (
  attrs: Record<string, unknown>,
  key: string,
  path: string,
  issues: ProseMirrorAttrIssue[],
): void => {
  const value = attrs[key];
  if (value === undefined || value === null) {
    return;
  }
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected an object." });
    return;
  }

  for (const numberKey of [
    "pageWidth",
    "pageHeight",
    "marginTop",
    "marginBottom",
    "marginLeft",
    "marginRight",
    "headerDistance",
    "footerDistance",
    "gutter",
    "columnCount",
    "columnSpace",
  ]) {
    optionalNumber(value, numberKey, `${path}.${numberKey}`, issues);
  }
  optionalOneOf(
    value,
    "orientation",
    `${path}.orientation`,
    issues,
    SECTION_ORIENTATIONS,
  );
  optionalOneOf(
    value,
    "sectionStart",
    `${path}.sectionStart`,
    issues,
    SECTION_START_TYPES,
  );
  optionalOneOf(
    value,
    "verticalAlign",
    `${path}.verticalAlign`,
    issues,
    SECTION_VERTICAL_ALIGNMENTS,
  );
  optionalBoolean(value, "equalWidth", `${path}.equalWidth`, issues);
  optionalBoolean(value, "separator", `${path}.separator`, issues);
  optionalBoolean(value, "bidi", `${path}.bidi`, issues);
  optionalBoolean(value, "titlePg", `${path}.titlePg`, issues);
  optionalBoolean(
    value,
    "evenAndOddHeaders",
    `${path}.evenAndOddHeaders`,
    issues,
  );
};

const optionalPropertyChanges = (
  attrs: Record<string, unknown>,
  key: string,
  path: string,
  issues: ProseMirrorAttrIssue[],
  allowedTypes: readonly string[],
): void => {
  const value = attrs[key];
  if (value === undefined || value === null) {
    return;
  }
  if (!Array.isArray(value)) {
    issues.push({ path, message: "Expected an array." });
    return;
  }

  for (const [index, item] of value.entries()) {
    const itemPath = `${path}[${index}]`;
    if (!isRecord(item)) {
      issues.push({ path: itemPath, message: "Expected an object." });
      continue;
    }
    requiredOneOf(item, "type", `${itemPath}.type`, issues, allowedTypes);
    validatePropertyChangeInfo(item["info"], `${itemPath}.info`, issues);
    optionalRecord(
      item,
      "previousFormatting",
      `${itemPath}.previousFormatting`,
      issues,
    );
    optionalRecord(
      item,
      "currentFormatting",
      `${itemPath}.currentFormatting`,
      issues,
    );
  }
};

const validatePropertyChangeInfo = (
  value: unknown,
  path: string,
  issues: ProseMirrorAttrIssue[],
): void => {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected an object." });
    return;
  }

  requiredNumber(value, "id", `${path}.id`, issues);
  requiredString(value, "author", `${path}.author`, issues);
  optionalString(value, "date", `${path}.date`, issues);
  optionalString(value, "rsid", `${path}.rsid`, issues);
};

const optionalImagePosition = (
  attrs: Record<string, unknown>,
  key: string,
  path: string,
  issues: ProseMirrorAttrIssue[],
): void => {
  const value = attrs[key];
  if (value === undefined || value === null) {
    return;
  }

  if (!isRecord(value)) {
    issues.push({ path, message: "Expected an object." });
    return;
  }

  validateImagePositionAxis(value, {
    key: "horizontal",
    path,
    relativeTo: IMAGE_HORIZONTAL_RELATIVE_TO_VALUES,
    align: IMAGE_HORIZONTAL_ALIGNMENT_VALUES,
    issues,
  });
  validateImagePositionAxis(value, {
    key: "vertical",
    path,
    relativeTo: IMAGE_VERTICAL_RELATIVE_TO_VALUES,
    align: IMAGE_VERTICAL_ALIGNMENT_VALUES,
    issues,
  });
};

type ImagePositionAxisValidation = {
  key: "horizontal" | "vertical";
  path: string;
  relativeTo: readonly string[];
  align: readonly string[];
  issues: ProseMirrorAttrIssue[];
};

const validateImagePositionAxis = (
  attrs: Record<string, unknown>,
  options: ImagePositionAxisValidation,
): void => {
  const value = attrs[options.key];
  if (value === undefined || value === null) {
    return;
  }

  const path = `${options.path}.${options.key}`;
  if (!isRecord(value)) {
    options.issues.push({ path, message: "Expected an object." });
    return;
  }

  optionalOneOf(
    value,
    "relativeTo",
    `${path}.relativeTo`,
    options.issues,
    options.relativeTo,
  );
  optionalNumber(value, "posOffset", `${path}.posOffset`, options.issues);
  optionalOneOf(value, "align", `${path}.align`, options.issues, options.align);
};

type OptionalNumberArrayOptions = {
  allowNull?: boolean;
};

const optionalNumberArray = (
  attrs: Record<string, unknown>,
  key: string,
  path: string,
  issues: ProseMirrorAttrIssue[],
  options: OptionalNumberArrayOptions = {},
): void => {
  const value = attrs[key];
  if (value === null && options.allowNull === true) {
    return;
  }

  if (value === undefined || value === null) {
    return;
  }

  if (!Array.isArray(value)) {
    issues.push({ path, message: "Expected an array of numbers." });
    return;
  }

  for (const [index, item] of value.entries()) {
    if (typeof item !== "number") {
      issues.push({
        path: `${path}[${index}]`,
        message: "Expected a number.",
      });
    }
  }
};

const optionalStringArray = (
  attrs: Record<string, unknown>,
  key: string,
  path: string,
  issues: ProseMirrorAttrIssue[],
): void => {
  const value = attrs[key];
  if (value === undefined || value === null) {
    return;
  }

  if (!Array.isArray(value)) {
    issues.push({ path, message: "Expected an array of strings." });
    return;
  }

  for (const [index, item] of value.entries()) {
    if (typeof item !== "string") {
      issues.push({
        path: `${path}[${index}]`,
        message: "Expected a string.",
      });
    }
  }
};

const validateNumPr = (
  value: unknown,
  issues: ProseMirrorAttrIssue[],
): void => {
  if (value === undefined || value === null || !isRecord(value)) {
    return;
  }

  validateNonNegativeInteger(
    value["numId"],
    "paragraph.attrs.numPr.numId",
    issues,
  );
  // Some real DOCX files use ilvl > 8; docx-core warns but preserves them.
  validateNonNegativeInteger(
    value["ilvl"],
    "paragraph.attrs.numPr.ilvl",
    issues,
  );
};

const validateNonNegativeInteger = (
  value: unknown,
  path: string,
  issues: ProseMirrorAttrIssue[],
): void => {
  if (value === undefined || value === null) {
    return;
  }

  if (typeof value !== "number") {
    issues.push({ path, message: "Expected a number." });
    return;
  }

  if (!Number.isInteger(value) || value < 0) {
    issues.push({ path, message: "Expected a non-negative integer." });
  }
};

const optionalBookmarkArray = (
  value: unknown,
  issues: ProseMirrorAttrIssue[],
): void => {
  if (value === undefined || value === null) {
    return;
  }

  if (!Array.isArray(value)) {
    issues.push({
      path: "paragraph.attrs.bookmarks",
      message: "Expected an array of bookmarks.",
    });
    return;
  }

  for (const [index, bookmark] of value.entries()) {
    if (!bookmark || typeof bookmark !== "object" || Array.isArray(bookmark)) {
      issues.push({
        path: `paragraph.attrs.bookmarks[${index}]`,
        message: "Expected a bookmark object.",
      });
      continue;
    }

    const attrs = bookmark as Record<string, unknown>;
    if (typeof attrs["id"] !== "number") {
      issues.push({
        path: `paragraph.attrs.bookmarks[${index}].id`,
        message: "Expected a number.",
      });
    }
    if (typeof attrs["name"] !== "string") {
      issues.push({
        path: `paragraph.attrs.bookmarks[${index}].name`,
        message: "Expected a string.",
      });
    }
  }
};

const optionalEmptyHyperlinkArray = (
  value: unknown,
  issues: ProseMirrorAttrIssue[],
): void => {
  if (value === undefined || value === null) {
    return;
  }

  if (!Array.isArray(value)) {
    issues.push({
      path: "paragraph.attrs._emptyHyperlinks",
      message: "Expected an array of empty hyperlinks.",
    });
    return;
  }

  for (const [index, item] of value.entries()) {
    const itemPath = `paragraph.attrs._emptyHyperlinks[${index}]`;
    if (!isRecord(item)) {
      issues.push({ path: itemPath, message: "Expected an object." });
      continue;
    }
    validateNonNegativeInteger(item["offset"], `${itemPath}.offset`, issues);
    optionalString(item, "href", `${itemPath}.href`, issues);
    optionalString(item, "anchor", `${itemPath}.anchor`, issues);
    optionalString(item, "tooltip", `${itemPath}.tooltip`, issues);
    optionalString(item, "rId", `${itemPath}.rId`, issues);
  }
};
