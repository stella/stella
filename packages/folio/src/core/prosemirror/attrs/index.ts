import type { Mark, Node as PMNode } from "prosemirror-model";

import type {
  CharacterSpacingAttrs,
  CommentAttrs,
  EmphasisMarkAttrs,
  FontFamilyAttrs,
  FontSizeAttrs,
  FootnoteRefAttrs,
  HighlightAttrs,
  HyperlinkAttrs,
  ImageAttrs,
  ParagraphAttrs,
  RunFormattingOverrideAttrs,
  StrikeAttrs,
  TableAttrs,
  TableCellAttrs,
  TableRowAttrs,
  TextColorAttrs,
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

type ImageHorizontalPositionAttrs = NonNullable<
  NonNullable<ImageAttrs["position"]>["horizontal"]
>;

type ImageVerticalPositionAttrs = NonNullable<
  NonNullable<ImageAttrs["position"]>["vertical"]
>;

const PARAGRAPH_ALIGNMENTS = [
  "left",
  "center",
  "right",
  "both",
  "distribute",
  "mediumKashida",
  "highKashida",
  "lowKashida",
  "thaiDistribute",
] as const satisfies readonly NonNullable<ParagraphAttrs["alignment"]>[];

const LINE_SPACING_RULES = [
  "auto",
  "exact",
  "atLeast",
] as const satisfies readonly NonNullable<ParagraphAttrs["lineSpacingRule"]>[];

const SECTION_BREAK_TYPES = [
  "nextPage",
  "continuous",
  "oddPage",
  "evenPage",
] as const satisfies readonly NonNullable<ParagraphAttrs["sectionBreakType"]>[];

const TABLE_WIDTH_TYPES = [
  "auto",
  "dxa",
  "nil",
  "pct",
] as const satisfies readonly NonNullable<TableAttrs["widthType"]>[];

const TABLE_JUSTIFICATIONS = [
  "left",
  "center",
  "right",
] as const satisfies readonly NonNullable<TableAttrs["justification"]>[];

const TABLE_ROW_HEIGHT_RULES = [
  "auto",
  "atLeast",
  "exact",
] as const satisfies readonly NonNullable<TableRowAttrs["heightRule"]>[];

const TABLE_CELL_VERTICAL_ALIGNMENTS = [
  "top",
  "center",
  "bottom",
] as const satisfies readonly NonNullable<TableCellAttrs["verticalAlign"]>[];

const TABLE_CELL_TEXT_DIRECTIONS = [
  "lr",
  "lrV",
  "rl",
  "rlV",
  "tb",
  "tbV",
  "tbRl",
  "tbRlV",
  "btLr",
] as const satisfies readonly NonNullable<TableCellAttrs["textDirection"]>[];

const HIGHLIGHT_COLORS = [
  "black",
  "blue",
  "cyan",
  "darkBlue",
  "darkCyan",
  "darkGray",
  "darkGreen",
  "darkMagenta",
  "darkRed",
  "darkYellow",
  "green",
  "lightGray",
  "magenta",
  "none",
  "red",
  "white",
  "yellow",
] as const satisfies readonly HighlightAttrs["color"][];

const IMAGE_WRAP_TYPES = [
  "inline",
  "square",
  "tight",
  "through",
  "topAndBottom",
  "behind",
  "inFront",
] as const satisfies readonly NonNullable<ImageAttrs["wrapType"]>[];

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

const IMAGE_WRAP_TEXTS = [
  "bothSides",
  "left",
  "right",
  "largest",
] as const satisfies readonly NonNullable<ImageAttrs["wrapText"]>[];

const IMAGE_HORIZONTAL_RELATIVE_TO = [
  "character",
  "column",
  "insideMargin",
  "leftMargin",
  "margin",
  "outsideMargin",
  "page",
  "rightMargin",
] as const satisfies readonly NonNullable<
  ImageHorizontalPositionAttrs["relativeTo"]
>[];

const IMAGE_HORIZONTAL_ALIGNMENTS = [
  "left",
  "right",
  "center",
  "inside",
  "outside",
] as const satisfies readonly NonNullable<
  ImageHorizontalPositionAttrs["align"]
>[];

const IMAGE_VERTICAL_RELATIVE_TO = [
  "insideMargin",
  "line",
  "margin",
  "outsideMargin",
  "page",
  "paragraph",
  "topMargin",
  "bottomMargin",
] as const satisfies readonly NonNullable<
  ImageVerticalPositionAttrs["relativeTo"]
>[];

const IMAGE_VERTICAL_ALIGNMENTS = [
  "top",
  "bottom",
  "center",
  "inside",
  "outside",
] as const satisfies readonly NonNullable<
  ImageVerticalPositionAttrs["align"]
>[];

const UNDERLINE_STYLES = [
  "none",
  "single",
  "words",
  "double",
  "thick",
  "dotted",
  "dottedHeavy",
  "dash",
  "dashedHeavy",
  "dashLong",
  "dashLongHeavy",
  "dotDash",
  "dashDotHeavy",
  "dotDotDash",
  "dashDotDotHeavy",
  "wave",
  "wavyHeavy",
  "wavyDouble",
] as const satisfies readonly NonNullable<UnderlineAttrs["style"]>[];

const EMPHASIS_MARK_TYPES = [
  "dot",
  "comma",
  "circle",
  "underDot",
] as const satisfies readonly NonNullable<EmphasisMarkAttrs["type"]>[];

const NOTE_TYPES = [
  "footnote",
  "endnote",
] as const satisfies readonly NonNullable<FootnoteRefAttrs["noteType"]>[];

const TRACKED_CHANGE_MOVE_KINDS = [
  "moveTo",
  "moveFrom",
] as const satisfies readonly NonNullable<TrackedChangeMarkAttrs["moveKind"]>[];

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
    PARAGRAPH_ALIGNMENTS,
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
    LINE_SPACING_RULES,
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
  optionalRecord(attrs, "borders", "paragraph.attrs.borders", issues);
  optionalRecord(attrs, "shading", "paragraph.attrs.shading", issues);
  optionalArray(attrs, "tabs", "paragraph.attrs.tabs", issues);
  optionalRecord(
    attrs,
    "spacingExplicit",
    "paragraph.attrs.spacingExplicit",
    issues,
  );
  optionalRecord(
    attrs,
    "defaultTextFormatting",
    "paragraph.attrs.defaultTextFormatting",
    issues,
  );
  optionalRecord(attrs, "numPr", "paragraph.attrs.numPr", issues);
  validateNumPr(attrs["numPr"], issues);
  optionalBookmarkArray(attrs["bookmarks"], issues);
  optionalRecord(
    attrs,
    "_sectionProperties",
    "paragraph.attrs._sectionProperties",
    issues,
  );
  optionalArray(
    attrs,
    "_propertyChanges",
    "paragraph.attrs._propertyChanges",
    issues,
  );

  return attrsResult(attrs, issues);
};

export const expectParagraphAttrs = (node: PMNode): ParagraphAttrs =>
  expectAttrs(readParagraphAttrs(node), "paragraph attrs");

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
    TABLE_WIDTH_TYPES,
  );
  optionalOneOf(
    attrs,
    "justification",
    "table.attrs.justification",
    issues,
    TABLE_JUSTIFICATIONS,
  );
  optionalNumberArray(
    attrs,
    "columnWidths",
    "table.attrs.columnWidths",
    issues,
  );
  optionalRecord(attrs, "floating", "table.attrs.floating", issues);
  optionalRecord(attrs, "cellMargins", "table.attrs.cellMargins", issues);
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
  expectAttrs(readTableAttrs(node), "table attrs");

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
    TABLE_ROW_HEIGHT_RULES,
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
  expectAttrs(readTableRowAttrs(node), "table row attrs");

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
    TABLE_WIDTH_TYPES,
  );
  optionalOneOf(
    attrs,
    "verticalAlign",
    "tableCell.attrs.verticalAlign",
    issues,
    TABLE_CELL_VERTICAL_ALIGNMENTS,
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
    TABLE_CELL_TEXT_DIRECTIONS,
  );
  optionalBoolean(attrs, "noWrap", "tableCell.attrs.noWrap", issues);
  optionalRecord(attrs, "borders", "tableCell.attrs.borders", issues);
  optionalRecord(attrs, "margins", "tableCell.attrs.margins", issues);
  optionalRecord(
    attrs,
    "_originalFormatting",
    "tableCell.attrs._originalFormatting",
    issues,
  );

  return attrsResult(attrs, issues);
};

export const expectTableCellAttrs = (node: PMNode): TableCellAttrs =>
  expectAttrs(readTableCellAttrs(node), "table cell attrs");

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
    IMAGE_WRAP_TYPES,
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
    IMAGE_WRAP_TEXTS,
  );
  optionalString(attrs, "hlinkHref", "image.attrs.hlinkHref", issues);

  return attrsResult(attrs, issues);
};

export const expectImageAttrs = (node: PMNode): ImageAttrs =>
  expectAttrs(readImageAttrs(node), "image attrs");

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
    UNDERLINE_STYLES,
  );
  optionalTextColor(attrs, "color", "underline.attrs.color", issues);

  return attrsResult(attrs, issues);
};

export const expectUnderlineMarkAttrs = (mark: Mark): UnderlineAttrs =>
  expectAttrs(readUnderlineMarkAttrs(mark), "underline attrs");

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
  expectAttrs(readStrikeMarkAttrs(mark), "strike attrs");

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
  expectAttrs(readTextColorMarkAttrs(mark), "text color attrs");

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
    HIGHLIGHT_COLORS,
  );

  return attrsResult(attrs, issues);
};

export const expectHighlightMarkAttrs = (mark: Mark): HighlightAttrs =>
  expectAttrs(readHighlightMarkAttrs(mark), "highlight attrs");

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
  expectAttrs(readFontSizeMarkAttrs(mark), "font size attrs");

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
  expectAttrs(readFontFamilyMarkAttrs(mark), "font family attrs");

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
  expectAttrs(readCharacterSpacingMarkAttrs(mark), "character spacing attrs");

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
  expectAttrs(readEmphasisMarkAttrs(mark), "emphasis mark attrs");

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
  expectAttrs(readFootnoteRefMarkAttrs(mark), "footnote reference attrs");

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
  expectAttrs(readCommentMarkAttrs(mark), "comment attrs");

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
  expectAttrs(readTrackedChangeMarkAttrs(mark), "tracked change attrs");

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
  expectAttrs(
    readRunFormattingOverrideMarkAttrs(mark),
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

  return attrsResult(attrs, issues);
};

export const expectHyperlinkMarkAttrs = (mark: Mark): HyperlinkAttrs =>
  expectAttrs(readHyperlinkMarkAttrs(mark), "hyperlink attrs");

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
  throw new Error(`Invalid ProseMirror ${label}:\n${details}`);
};

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
  optionalString(attrs, "themeColor", `${path}.themeColor`, issues);
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
    relativeTo: IMAGE_HORIZONTAL_RELATIVE_TO,
    align: IMAGE_HORIZONTAL_ALIGNMENTS,
    issues,
  });
  validateImagePositionAxis(value, {
    key: "vertical",
    path,
    relativeTo: IMAGE_VERTICAL_RELATIVE_TO,
    align: IMAGE_VERTICAL_ALIGNMENTS,
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
  if (value === undefined || value === null || Array.isArray(value)) {
    return;
  }

  if (typeof value !== "object") {
    return;
  }

  const numPr = value as Record<string, unknown>;
  if (numPr["numId"] !== undefined && typeof numPr["numId"] !== "number") {
    issues.push({
      path: "paragraph.attrs.numPr.numId",
      message: "Expected a number.",
    });
  }

  if (numPr["ilvl"] !== undefined && typeof numPr["ilvl"] !== "number") {
    issues.push({
      path: "paragraph.attrs.numPr.ilvl",
      message: "Expected a number.",
    });
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
