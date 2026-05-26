import type {
  EmphasisMark,
  FieldType,
  FloatingTableProperties,
  ImagePosition,
  ImageWrap,
  LevelSuffix,
  LineSpacingRule,
  NumberFormat,
  ParagraphAlignment,
  ParagraphFormatting,
  SdtProperties,
  SdtType,
  ShadingProperties,
  ShapeOutline,
  Style,
  StyleType,
  TableCellFormatting,
  TableFormatting,
  TableRowFormatting,
  TableWidthType,
  TabLeader,
  TabStopAlignment,
  TextEffect,
  TextFormatting,
  ThemeColorSlot,
  UnderlineStyle,
  KnownBorderStyle,
} from "./document";

export const THEME_COLOR_SLOT_VALUES = [
  "dk1",
  "lt1",
  "dk2",
  "lt2",
  "accent1",
  "accent2",
  "accent3",
  "accent4",
  "accent5",
  "accent6",
  "hlink",
  "folHlink",
  "background1",
  "text1",
  "background2",
  "text2",
] as const satisfies readonly ThemeColorSlot[];

export const BORDER_STYLE_VALUES = [
  "none",
  "single",
  "double",
  "dotted",
  "dashed",
  "thick",
  "triple",
  "thinThickSmallGap",
  "thickThinSmallGap",
  "thinThickMediumGap",
  "thickThinMediumGap",
  "thinThickLargeGap",
  "thickThinLargeGap",
  "wave",
  "doubleWave",
  "dashSmallGap",
  "dashDotStroked",
  "threeDEmboss",
  "threeDEngrave",
  "outset",
  "inset",
  "nil",
] as const satisfies readonly KnownBorderStyle[];

export const UNDERLINE_STYLE_VALUES = [
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
] as const satisfies readonly UnderlineStyle[];

export const HIGHLIGHT_COLOR_VALUES = [
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
] as const satisfies readonly NonNullable<TextFormatting["highlight"]>[];

export const TEXT_EFFECT_VALUES = [
  "none",
  "blinkBackground",
  "lights",
  "antsBlack",
  "antsRed",
  "shimmer",
  "sparkle",
] as const satisfies readonly TextEffect[];

export const EMPHASIS_MARK_VALUES = [
  "none",
  "dot",
  "comma",
  "circle",
  "underDot",
] as const satisfies readonly EmphasisMark[];

type FontTheme = NonNullable<
  NonNullable<TextFormatting["fontFamily"]>["asciiTheme"]
>;

export const FONT_THEME_VALUES = [
  "majorAscii",
  "majorHAnsi",
  "majorEastAsia",
  "majorBidi",
  "minorAscii",
  "minorHAnsi",
  "minorEastAsia",
  "minorBidi",
] as const satisfies readonly FontTheme[];

export const PARAGRAPH_ALIGNMENT_VALUES = [
  "left",
  "center",
  "right",
  "both",
  "distribute",
  "mediumKashida",
  "highKashida",
  "lowKashida",
  "thaiDistribute",
] as const satisfies readonly ParagraphAlignment[];

export const LINE_SPACING_RULE_VALUES = [
  "auto",
  "exact",
  "atLeast",
] as const satisfies readonly LineSpacingRule[];

export const TAB_STOP_ALIGNMENT_VALUES = [
  "left",
  "center",
  "right",
  "decimal",
  "bar",
  "clear",
  "num",
] as const satisfies readonly TabStopAlignment[];

export const TAB_LEADER_VALUES = [
  "none",
  "dot",
  "hyphen",
  "underscore",
  "heavy",
  "middleDot",
] as const satisfies readonly TabLeader[];

type Frame = NonNullable<ParagraphFormatting["frame"]>;

export const FRAME_X_ALIGN_VALUES = [
  "left",
  "center",
  "right",
  "inside",
  "outside",
] as const satisfies readonly NonNullable<Frame["xAlign"]>[];

export const FRAME_Y_ALIGN_VALUES = [
  "top",
  "center",
  "bottom",
  "inside",
  "outside",
  "inline",
] as const satisfies readonly NonNullable<Frame["yAlign"]>[];

export const FRAME_WRAP_VALUES = [
  "around",
  "auto",
  "none",
  "notBeside",
  "through",
  "tight",
] as const satisfies readonly NonNullable<Frame["wrap"]>[];

export const SDT_LOCK_VALUES = [
  "sdtLocked",
  "contentLocked",
  "sdtContentLocked",
  "unlocked",
] as const satisfies readonly NonNullable<SdtProperties["lock"]>[];

export const SDT_TYPE_VALUES = [
  "richText",
  "plainText",
  "date",
  "dropdown",
  "comboBox",
  "checkbox",
  "picture",
  "buildingBlockGallery",
  "group",
  "unknown",
] as const satisfies readonly SdtType[];

export const FIELD_TYPE_VALUES = [
  "PAGE",
  "NUMPAGES",
  "NUMWORDS",
  "NUMCHARS",
  "DATE",
  "TIME",
  "CREATEDATE",
  "SAVEDATE",
  "PRINTDATE",
  "AUTHOR",
  "TITLE",
  "SUBJECT",
  "KEYWORDS",
  "COMMENTS",
  "FILENAME",
  "FILESIZE",
  "TEMPLATE",
  "DOCPROPERTY",
  "DOCVARIABLE",
  "REF",
  "PAGEREF",
  "NOTEREF",
  "HYPERLINK",
  "TOC",
  "TOA",
  "INDEX",
  "SEQ",
  "STYLEREF",
  "AUTONUM",
  "AUTONUMLGL",
  "AUTONUMOUT",
  "IF",
  "MERGEFIELD",
  "NEXT",
  "NEXTIF",
  "ASK",
  "SET",
  "QUOTE",
  "INCLUDETEXT",
  "INCLUDEPICTURE",
  "SYMBOL",
  "ADVANCE",
  "EDITTIME",
  "REVNUM",
  "SECTION",
  "SECTIONPAGES",
  "USERADDRESS",
  "USERNAME",
  "USERINITIALS",
  "UNKNOWN",
] as const satisfies readonly FieldType[];

export const STYLE_TYPE_VALUES = [
  "paragraph",
  "character",
  "numbering",
  "table",
] as const satisfies readonly StyleType[];

type ConditionalStyleType = NonNullable<Style["tblStylePr"]>[number]["type"];

export const CONDITIONAL_STYLE_TYPE_VALUES = [
  "band1Horz",
  "band1Vert",
  "band2Horz",
  "band2Vert",
  "firstCol",
  "firstRow",
  "lastCol",
  "lastRow",
  "neCell",
  "nwCell",
  "seCell",
  "swCell",
  "wholeTable",
] as const satisfies readonly ConditionalStyleType[];

export const TABLE_WIDTH_TYPE_VALUES = [
  "auto",
  "dxa",
  "nil",
  "pct",
] as const satisfies readonly TableWidthType[];

export const TABLE_JUSTIFICATION_VALUES = [
  "left",
  "center",
  "right",
] as const satisfies readonly NonNullable<TableFormatting["justification"]>[];

export const TABLE_ROW_HEIGHT_RULE_VALUES = [
  "auto",
  "atLeast",
  "exact",
] as const satisfies readonly NonNullable<TableRowFormatting["heightRule"]>[];

export const TABLE_CELL_VERTICAL_ALIGNMENT_VALUES = [
  "top",
  "center",
  "bottom",
] as const satisfies readonly NonNullable<
  TableCellFormatting["verticalAlign"]
>[];

export const TABLE_CELL_TEXT_DIRECTION_VALUES = [
  "lr",
  "lrV",
  "rl",
  "rlV",
  "tb",
  "tbV",
  "tbRl",
  "tbRlV",
  "btLr",
] as const satisfies readonly NonNullable<
  TableCellFormatting["textDirection"]
>[];

export const SHADING_PATTERN_VALUES = [
  "clear",
  "solid",
  "horzStripe",
  "vertStripe",
  "reverseDiagStripe",
  "diagStripe",
  "horzCross",
  "diagCross",
  "thinHorzStripe",
  "thinVertStripe",
  "thinReverseDiagStripe",
  "thinDiagStripe",
  "thinHorzCross",
  "thinDiagCross",
  "pct5",
  "pct10",
  "pct12",
  "pct15",
  "pct20",
  "pct25",
  "pct30",
  "pct35",
  "pct37",
  "pct40",
  "pct45",
  "pct50",
  "pct55",
  "pct60",
  "pct62",
  "pct65",
  "pct70",
  "pct75",
  "pct80",
  "pct85",
  "pct87",
  "pct90",
  "pct95",
  "nil",
] as const satisfies readonly NonNullable<ShadingProperties["pattern"]>[];

export const FLOATING_TABLE_X_SPEC_VALUES = [
  "left",
  "center",
  "right",
  "inside",
  "outside",
] as const satisfies readonly NonNullable<
  FloatingTableProperties["tblpXSpec"]
>[];

export const FLOATING_TABLE_Y_SPEC_VALUES = [
  "top",
  "center",
  "bottom",
  "inside",
  "outside",
  "inline",
] as const satisfies readonly NonNullable<
  FloatingTableProperties["tblpYSpec"]
>[];

export const IMAGE_WRAP_TYPE_VALUES = [
  "inline",
  "square",
  "tight",
  "through",
  "topAndBottom",
  "behind",
  "inFront",
] as const satisfies readonly ImageWrap["type"][];

export const IMAGE_HORIZONTAL_RELATIVE_TO_VALUES = [
  "character",
  "column",
  "insideMargin",
  "leftMargin",
  "margin",
  "outsideMargin",
  "page",
  "rightMargin",
] as const satisfies readonly ImagePosition["horizontal"]["relativeTo"][];

export const IMAGE_HORIZONTAL_ALIGNMENT_VALUES = [
  "left",
  "right",
  "center",
  "inside",
  "outside",
] as const satisfies readonly NonNullable<
  ImagePosition["horizontal"]["alignment"]
>[];

export const IMAGE_VERTICAL_RELATIVE_TO_VALUES = [
  "insideMargin",
  "line",
  "margin",
  "outsideMargin",
  "page",
  "paragraph",
  "topMargin",
  "bottomMargin",
] as const satisfies readonly ImagePosition["vertical"]["relativeTo"][];

export const IMAGE_VERTICAL_ALIGNMENT_VALUES = [
  "top",
  "bottom",
  "center",
  "inside",
  "outside",
] as const satisfies readonly NonNullable<
  ImagePosition["vertical"]["alignment"]
>[];

export const IMAGE_WRAP_TEXT_VALUES = [
  "bothSides",
  "left",
  "right",
  "largest",
] as const satisfies readonly NonNullable<ImageWrap["wrapText"]>[];

export const SHAPE_OUTLINE_STYLE_VALUES = [
  "solid",
  "dot",
  "dash",
  "lgDash",
  "dashDot",
  "lgDashDot",
  "lgDashDotDot",
  "sysDot",
  "sysDash",
  "sysDashDot",
  "sysDashDotDot",
] as const satisfies readonly NonNullable<ShapeOutline["style"]>[];

export const NUMBER_FORMAT_VALUES = [
  "decimal",
  "upperRoman",
  "lowerRoman",
  "upperLetter",
  "lowerLetter",
  "ordinal",
  "cardinalText",
  "ordinalText",
  "hex",
  "chicago",
  "ideographDigital",
  "japaneseCounting",
  "aiueo",
  "iroha",
  "decimalFullWidth",
  "decimalHalfWidth",
  "japaneseLegal",
  "japaneseDigitalTenThousand",
  "decimalEnclosedCircle",
  "decimalFullWidth2",
  "aiueoFullWidth",
  "irohaFullWidth",
  "decimalZero",
  "bullet",
  "ganada",
  "chosung",
  "decimalEnclosedFullstop",
  "decimalEnclosedParen",
  "decimalEnclosedCircleChinese",
  "ideographEnclosedCircle",
  "ideographTraditional",
  "ideographZodiac",
  "ideographZodiacTraditional",
  "taiwaneseCounting",
  "ideographLegalTraditional",
  "taiwaneseCountingThousand",
  "taiwaneseDigital",
  "chineseCounting",
  "chineseLegalSimplified",
  "chineseCountingThousand",
  "koreanDigital",
  "koreanCounting",
  "koreanLegal",
  "koreanDigital2",
  "vietnameseCounting",
  "russianLower",
  "russianUpper",
  "none",
  "numberInDash",
  "hebrew1",
  "hebrew2",
  "arabicAlpha",
  "arabicAbjad",
  "hindiVowels",
  "hindiConsonants",
  "hindiNumbers",
  "hindiCounting",
  "thaiLetters",
  "thaiNumbers",
  "thaiCounting",
] as const satisfies readonly NumberFormat[];

export const LEVEL_SUFFIX_VALUES = [
  "tab",
  "space",
  "nothing",
] as const satisfies readonly LevelSuffix[];
