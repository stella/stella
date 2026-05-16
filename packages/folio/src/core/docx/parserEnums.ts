/**
 * OOXML enum schemas for parser narrowing.
 *
 * Parsers throughout this directory read string-valued XML attributes
 * (`<w:u w:val="single"/>`, `<w:pgBorders w:val="dashed"/>`, …) that
 * the document model types as a small literal union. The historical
 * pattern was `getAttribute(...) as UnderlineStyle`, which lies to
 * the type system: a malformed file produces a typed value that
 * silently contains garbage and breaks downstream consumers.
 *
 * These valibot picklists are the single source of truth for each
 * OOXML enum. `narrowEnum(value, schema)` widens a parsed string to
 * the typed enum *iff* the value is recognised; unknown values
 * become `undefined` so callers can fall back to a default, matching
 * how Word degrades when it doesn't recognise a value.
 *
 * Picklist entries are checked at compile time against the TS union
 * via `satisfies` — a new variant added to the model type fails to
 * compile until the picklist is updated, giving the same compile-time
 * coverage gate as `switch-exhaustiveness-check`.
 */

import * as v from "valibot";

import type {
  BorderSpec,
  EmphasisMark,
  FieldType,
  LineSpacingRule,
  ParagraphAlignment,
  ParagraphFormatting,
  SdtProperties,
  ShadingProperties,
  TabLeader,
  TabStopAlignment,
  TextEffect,
  TextFormatting,
  ThemeColorSlot,
  UnderlineStyle,
} from "../types/document";

/**
 * Narrow a raw attribute string to a picklist member, or `undefined`
 * if the value isn't recognised. The cast lives once inside the
 * valibot output type; callers receive a properly-typed value with
 * no `as` at the call site.
 */
export const narrowEnum = <T extends string>(
  value: string | null | undefined,
  schema: v.PicklistSchema<readonly T[], undefined>,
): T | undefined => {
  if (value === null || value === undefined) {
    return undefined;
  }
  const result = v.safeParse(schema, value);
  return result.success ? result.output : undefined;
};

// ---------------------------------------------------------------------------
// Theme & shading enums
// ---------------------------------------------------------------------------

export const ThemeColorSlotSchema = v.picklist([
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
] as const satisfies readonly ThemeColorSlot[]);

export const BorderStyleSchema = v.picklist([
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
] as const satisfies readonly BorderSpec["style"][]);

// ---------------------------------------------------------------------------
// Run formatting enums
// ---------------------------------------------------------------------------

export const UnderlineStyleSchema = v.picklist([
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
] as const satisfies readonly UnderlineStyle[]);

export const HighlightColorSchema = v.picklist([
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
] as const satisfies readonly NonNullable<TextFormatting["highlight"]>[]);

export const TextEffectSchema = v.picklist([
  "none",
  "blinkBackground",
  "lights",
  "antsBlack",
  "antsRed",
  "shimmer",
  "sparkle",
] as const satisfies readonly TextEffect[]);

export const EmphasisMarkSchema = v.picklist([
  "none",
  "dot",
  "comma",
  "circle",
  "underDot",
] as const satisfies readonly EmphasisMark[]);

type FontTheme = NonNullable<
  NonNullable<TextFormatting["fontFamily"]>["asciiTheme"]
>;

export const FontThemeSchema = v.picklist([
  "majorAscii",
  "majorHAnsi",
  "majorEastAsia",
  "majorBidi",
  "minorAscii",
  "minorHAnsi",
  "minorEastAsia",
  "minorBidi",
] as const satisfies readonly FontTheme[]);

// ---------------------------------------------------------------------------
// Paragraph formatting enums
// ---------------------------------------------------------------------------

export const ParagraphAlignmentSchema = v.picklist([
  "left",
  "center",
  "right",
  "both",
  "distribute",
  "mediumKashida",
  "highKashida",
  "lowKashida",
  "thaiDistribute",
] as const satisfies readonly ParagraphAlignment[]);

export const LineSpacingRuleSchema = v.picklist([
  "auto",
  "exact",
  "atLeast",
] as const satisfies readonly LineSpacingRule[]);

export const TabStopAlignmentSchema = v.picklist([
  "left",
  "center",
  "right",
  "decimal",
  "bar",
  "clear",
  "num",
] as const satisfies readonly TabStopAlignment[]);

export const TabLeaderSchema = v.picklist([
  "none",
  "dot",
  "hyphen",
  "underscore",
  "heavy",
  "middleDot",
] as const satisfies readonly TabLeader[]);

type Frame = NonNullable<ParagraphFormatting["frame"]>;

export const FrameXAlignSchema = v.picklist([
  "left",
  "center",
  "right",
  "inside",
  "outside",
] as const satisfies readonly NonNullable<Frame["xAlign"]>[]);

export const FrameYAlignSchema = v.picklist([
  "top",
  "center",
  "bottom",
  "inside",
  "outside",
  "inline",
] as const satisfies readonly NonNullable<Frame["yAlign"]>[]);

export const FrameWrapSchema = v.picklist([
  "around",
  "auto",
  "none",
  "notBeside",
  "through",
  "tight",
] as const satisfies readonly NonNullable<Frame["wrap"]>[]);

// ---------------------------------------------------------------------------
// Structured document tag (SDT) enums
// ---------------------------------------------------------------------------

export const SdtLockSchema = v.picklist([
  "sdtLocked",
  "contentLocked",
  "sdtContentLocked",
  "unlocked",
] as const satisfies readonly NonNullable<SdtProperties["lock"]>[]);

// ---------------------------------------------------------------------------
// Field types
// ---------------------------------------------------------------------------

export const FieldTypeSchema = v.picklist([
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
] as const satisfies readonly FieldType[]);

// ---------------------------------------------------------------------------
// Shading enums
// ---------------------------------------------------------------------------

export const ShadingPatternSchema = v.picklist([
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
] as const satisfies readonly NonNullable<ShadingProperties["pattern"]>[]);
