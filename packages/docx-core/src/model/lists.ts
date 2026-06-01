/**
 * Lists & Numbering Types
 *
 * Types for bullet lists, numbered lists, and numbering definitions.
 */

import type { TextFormatting, ParagraphFormatting } from "./formatting";

// ============================================================================
// LISTS & NUMBERING
// ============================================================================

/**
 * Number format type
 */
export type NumberFormat =
  | "decimal"
  | "upperRoman"
  | "lowerRoman"
  | "upperLetter"
  | "lowerLetter"
  | "ordinal"
  | "cardinalText"
  | "ordinalText"
  | "hex"
  | "chicago"
  | "ideographDigital"
  | "japaneseCounting"
  | "aiueo"
  | "iroha"
  | "decimalFullWidth"
  | "decimalHalfWidth"
  | "japaneseLegal"
  | "japaneseDigitalTenThousand"
  | "decimalEnclosedCircle"
  | "decimalFullWidth2"
  | "aiueoFullWidth"
  | "irohaFullWidth"
  | "decimalZero"
  | "bullet"
  | "ganada"
  | "chosung"
  | "decimalEnclosedFullstop"
  | "decimalEnclosedParen"
  | "decimalEnclosedCircleChinese"
  | "ideographEnclosedCircle"
  | "ideographTraditional"
  | "ideographZodiac"
  | "ideographZodiacTraditional"
  | "taiwaneseCounting"
  | "ideographLegalTraditional"
  | "taiwaneseCountingThousand"
  | "taiwaneseDigital"
  | "chineseCounting"
  | "chineseLegalSimplified"
  | "chineseCountingThousand"
  | "koreanDigital"
  | "koreanCounting"
  | "koreanLegal"
  | "koreanDigital2"
  | "vietnameseCounting"
  | "russianLower"
  | "russianUpper"
  | "none"
  | "numberInDash"
  | "hebrew1"
  | "hebrew2"
  | "arabicAlpha"
  | "arabicAbjad"
  | "hindiVowels"
  | "hindiConsonants"
  | "hindiNumbers"
  | "hindiCounting"
  | "thaiLetters"
  | "thaiNumbers"
  | "thaiCounting";

/**
 * Multi-level suffix (what follows the number)
 */
export type LevelSuffix = "tab" | "space" | "nothing";

/**
 * List level definition
 */
export type ListLevel = {
  /** Level index (0-8) */
  ilvl: number;
  /** Starting number */
  start?: number;
  /** Number format */
  numFmt: NumberFormat;
  /** Level text (e.g., "%1." or "•") */
  lvlText: string;
  /** Justification */
  lvlJc?: "left" | "center" | "right";
  /** Suffix after number */
  suffix?: LevelSuffix;
  /** Paragraph properties for this level */
  pPr?: ParagraphFormatting;
  /** Run properties for the number/bullet */
  rPr?: TextFormatting;
  /** Restart numbering from higher level */
  lvlRestart?: number;
  /** Is legal numbering style */
  isLgl?: boolean;
  /** Legacy settings */
  legacy?: {
    legacy?: boolean;
    legacySpace?: number;
    legacyIndent?: number;
  };
};

/**
 * Abstract numbering definition (w:abstractNum)
 */
export type AbstractNumbering = {
  /** Abstract numbering ID */
  abstractNumId: number;
  /** Multi-level type */
  multiLevelType?: "hybridMultilevel" | "multilevel" | "singleLevel";
  /** Numbering style link */
  numStyleLink?: string;
  /** Style link */
  styleLink?: string;
  /** Level definitions */
  levels: ListLevel[];
  /** Name */
  name?: string;
};

/**
 * Numbering instance (w:num)
 */
export type NumberingInstance = {
  /** Numbering ID (referenced by paragraphs) */
  numId: number;
  /** Reference to abstract numbering */
  abstractNumId: number;
  /** Level overrides */
  levelOverrides?: {
    ilvl: number;
    startOverride?: number;
    lvl?: ListLevel;
  }[];
};

/**
 * Computed list rendering info
 */
export type ListRendering = {
  /** Computed marker text (e.g., "1.", "a)", "•") */
  marker: string;
  /** List level (0-8) */
  level: number;
  /** Numbering ID */
  numId: number;
  /** Whether this is a bullet or numbered list */
  isBullet: boolean;
  /** Whether this level uses legal numbering (parent placeholders render decimal). */
  isLegal?: boolean;
  /** Number format type (decimal, lowerRoman, upperRoman, etc.) */
  numFmt?: NumberFormat;
  /** Whether the list marker is hidden (w:vanish on level rPr) */
  markerHidden?: boolean;
  /** Marker font family from numbering level rPr (ascii name) */
  markerFontFamily?: string;
  /** Marker font size from numbering level rPr, in points */
  markerFontSize?: number;
  /**
   * `w:caps` on the numbering level rPr — the marker text renders in upper
   * case (e.g. "SCHEDULE 1" instead of "Schedule 1"). Apply at substitution
   * time so number-format letters (lowerLetter / lowerRoman) also flip.
   */
  markerAllCaps?: boolean;
  /**
   * `w:suff` (§17.9.25) — what follows the marker before body text.
   * `tab` (the OOXML default) grows the marker to the next tab stop; `space`
   * adds one space glyph; `nothing` lets body text butt against the marker.
   */
  markerSuffix?: LevelSuffix;
  /** Number format for each level from 0 through this paragraph's level. */
  levelNumFmts?: NumberFormat[];
  /** Abstract numbering definition shared by one or more numIds. */
  abstractNumId?: number;
  /** Start override for this numId/level, if the numbering instance defines one. */
  startOverride?: number;
  /**
   * Number of inline `LISTNUM` (default-list) fields the paragraph contains.
   * Each represents an implicit counter advance at `ilvl + 1` (Word's
   * default LISTNUM behaviour), so the next paragraph at that depth picks
   * up the next letter — e.g. an OutNum2 line carrying inline "(a)" must
   * be followed by an OutNum3 "(b)", not another "(a)".
   */
  implicitChildLevelAdvances?: number;
  /**
   * Column offset (in twips, from the marker zone's left edge) where the
   * second slot of a tab-separated marker should land. Set when LISTNUM is
   * folded into the marker so the cached "(a)" aligns vertically with the
   * deeper level's marker column. Uses the next ilvl's `hangingIndent`.
   */
  markerSecondSlotOffsetTwips?: number;
};

/**
 * Complete numbering definitions
 */
export type NumberingDefinitions = {
  /** Abstract numbering definitions */
  abstractNums: AbstractNumbering[];
  /** Numbering instances */
  nums: NumberingInstance[];
};
