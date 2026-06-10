/**
 * ProseMirror Mark Type Interfaces
 *
 * Type definitions for mark attributes used by conversion modules,
 * extensions, and other consumers. MarkSpec definitions have moved
 * to the extension system (extensions/marks/).
 */

import type { ShadingProperties } from "../../types/colors";
import type {
  EmphasisMark,
  TextEffect,
  TextFormatting,
  ThemeColorSlot,
  UnderlineStyle,
} from "../../types/document";

/**
 * Text color mark attributes
 */
export type TextColorAttrs = {
  rgb?: string;
  themeColor?: ThemeColorSlot;
  themeTint?: string;
  themeShade?: string;
};

/**
 * Underline mark attributes
 */
export type UnderlineAttrs = {
  style?: UnderlineStyle;
  color?: TextColorAttrs;
};

export type StrikeAttrs = {
  double?: boolean;
};

/**
 * Font size mark attributes
 */
export type FontSizeAttrs = {
  size: number; // in half-points (OOXML format)
};

/**
 * Font family mark attributes
 */
export type FontFamilyAttrs = {
  ascii?: string;
  hAnsi?: string;
  eastAsia?: string;
  cs?: string;
  asciiTheme?: string;
  hAnsiTheme?: string;
  eastAsiaTheme?: string;
  csTheme?: string;
};

export type HighlightAttrs = {
  color: NonNullable<TextFormatting["highlight"]>;
};

/**
 * Run-level shading mark attributes (w:shd). Carries the shading FILL as a
 * flattened ColorValue (mirroring TextColorAttrs) plus the pattern. The default
 * `clear` pattern is never stored (absence ⇒ the fill renders as a solid
 * background and re-serializes to `w:val="clear"`); only non-clear patterns
 * (`pct*`, stripes) are carried for export fidelity (`solid` is flattened into
 * the fill). `patternColor` is the pattern foreground rgb (`w:shd w:color`),
 * carried so a non-clear pattern's color survives export.
 */
export type RunShadingAttrs = TextColorAttrs & {
  pattern?: NonNullable<ShadingProperties["pattern"]>;
  patternColor?: string;
};

export type CharacterSpacingAttrs = {
  spacing?: number;
  position?: number;
  scale?: number;
  kerning?: number;
};

export type EmphasisMarkAttrs = {
  type?: Exclude<EmphasisMark, "none">;
};

/**
 * Text effect mark attributes (w:effect). The "none" sentinel is never marked;
 * absence of the mark is the no-effect state.
 */
export type TextEffectAttrs = {
  effect: Exclude<TextEffect, "none">;
};

export type FootnoteRefAttrs = {
  id: string | number;
  noteType?: "footnote" | "endnote";
};

export type CommentAttrs = {
  commentId: number;
};

export type TrackedChangeMarkAttrs = {
  revisionId: number;
  author: string;
  date?: string;
  moveKind?: "moveTo" | "moveFrom";
};

export type RunFormattingOverrideAttrs = {
  [K in keyof Pick<
    TextFormatting,
    | "bold"
    | "italic"
    | "strike"
    | "doubleStrike"
    | "allCaps"
    | "smallCaps"
    | "hidden"
    | "emboss"
    | "imprint"
    | "shadow"
    | "outline"
    | "rtl"
  >]?: false;
} & {
  underline?: "none";
};

/**
 * Character style mark attributes (w:rStyle).
 *
 * `styleId` is the OOXML character style reference, carried so a styled run
 * re-serializes as a style reference instead of losing the semantic link.
 * `_styleRPr` is the style's own run properties snapshotted at load in mark
 * normal form (the shape `marksToTextFormatting` produces); `fromProseDoc`
 * subtracts values equal to this snapshot so style-provided formatting is not
 * baked into the run as direct formatting on save. It is absent when the
 * style was unknown at load — nothing was resolved, so nothing is subtracted
 * and the reference round-trips verbatim.
 */
export type CharacterStyleAttrs = {
  styleId: string;
  _styleRPr?: TextFormatting;
};

/**
 * Hyperlink mark attributes
 */
export type HyperlinkAttrs = {
  href: string;
  tooltip?: string;
  rId?: string;
  _docxHyperlinkIndex?: number;
};
