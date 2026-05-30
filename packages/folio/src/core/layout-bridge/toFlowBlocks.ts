/**
 * ProseMirror to FlowBlock Converter
 *
 * Converts a ProseMirror document into FlowBlock[] for the layout engine.
 * Tracks pmStart/pmEnd positions for click-to-position mapping.
 */

import type { Node as PMNode, Mark } from "prosemirror-model";

import { convertBulletToUnicode } from "../docx/bulletMarkers";
import type {
  FlowBlock,
  ParagraphBlock,
  TableBlock,
  TableRow,
  TableCell,
  CellBorders,
  BorderStyle,
  ImageBlock,
  TextBoxBlock,
  PageBreakBlock,
  SectionBreakBlock,
  ColumnLayout,
  Run,
  TextRun,
  TabRun,
  ImageRun,
  FieldRun,
  RunFormatting,
  ParagraphAttrs,
  TabStop,
  FloatingTablePosition,
} from "../layout-engine/types";
import {
  DEFAULT_TEXTBOX_MARGINS,
  DEFAULT_TEXTBOX_WIDTH,
} from "../layout-engine/types";
import {
  expectCharacterSpacingMarkAttrs,
  expectCommentMarkAttrs,
  expectEmphasisMarkAttrs,
  expectFieldAttrs,
  expectFontFamilyMarkAttrs,
  expectFontSizeMarkAttrs,
  expectFootnoteRefMarkAttrs,
  expectHighlightMarkAttrs,
  expectHyperlinkMarkAttrs,
  expectImageAttrs,
  expectMathAttrs,
  expectParagraphAttrs,
  expectRunFormattingOverrideMarkAttrs,
  expectTableAttrs,
  expectTableCellAttrs,
  expectTableRowAttrs,
  expectTextBoxAttrs,
  expectTextColorMarkAttrs,
  expectTextEffectMarkAttrs,
  expectTrackedChangeMarkAttrs,
  expectUnderlineMarkAttrs,
} from "../prosemirror/attrs";
import type { RunFormattingOverrideAttrs } from "../prosemirror/schema/marks";
import type {
  ImageAttrs,
  ParagraphAttrs as PMParagraphAttrs,
} from "../prosemirror/schema/nodes";
import { assertValidProseMirrorDocument } from "../prosemirror/validation";
import type {
  ColorValue,
  Theme,
  SectionProperties,
  NumberFormat,
  TextFormatting,
} from "../types/document";
import { resolveColor, resolveHighlightToCss } from "../utils/colorResolver";
import {
  pointsToPixels,
  halfPointsToPixels,
  halfPointsToPoints,
} from "../utils/units";

/**
 * Options for the conversion.
 */
export type ToFlowBlocksOptions = {
  /** Default font family. */
  defaultFont?: string;
  /** Default font size in points. */
  defaultSize?: number;
  /** Theme for resolving theme colors. */
  theme?: Theme | null;
  /** Page content height in pixels (pageHeight - marginTop - marginBottom). Images taller than this are scaled down to fit. */
  pageContentHeight?: number;
  /** Shared list counters for nested containers. */
  listCounters?: Map<number, number[]>;
  /** Latest concrete counters by abstract numbering definition. */
  listAbstractCounters?: Map<number, number[]>;
  /** Shared startOverride state for nested containers. */
  listSeenNumIds?: Set<string>;
  /**
   * Document-wide `w:defaultTabStop` (§17.6.13) in twips. Stamped onto
   * every paragraph block so paragraph-local layout helpers (list marker
   * tab-stop math) can read it without taking a `Document` reference.
   * Defaults to the OOXML 720-twip value when absent.
   */
  defaultTabStopTwips?: number;
};

const DEFAULT_FONT = "Calibri";
const DEFAULT_TABLE_CELL_MARGIN_TWIPS = {
  top: 0,
  right: 108,
  bottom: 0,
  left: 108,
} as const;
type TablePaddingSide = keyof typeof DEFAULT_TABLE_CELL_MARGIN_TWIPS;
const DEFAULT_BLACK_TEXT_COLOR_VALUES = new Set(["000000", "000"]);

function normalizeResolvedTextColor(color: string): string {
  return color.trim().toLowerCase().replace(/^#/u, "");
}

function isDefaultBlackResolvedTextColor(color: string): boolean {
  return DEFAULT_BLACK_TEXT_COLOR_VALUES.has(normalizeResolvedTextColor(color));
}

function areResolvedTextColorsEqual(left: string, right: string): boolean {
  return normalizeResolvedTextColor(left) === normalizeResolvedTextColor(right);
}

/**
 * Constrain image dimensions to fit within the page content area.
 * Scales proportionally if height exceeds pageContentHeight.
 */
function constrainImageToPage(
  width: number,
  height: number,
  pageContentHeight: number | undefined,
): { width: number; height: number } {
  if (!pageContentHeight || height <= pageContentHeight) {
    return { width, height };
  }
  const scale = pageContentHeight / height;
  return { width: Math.round(width * scale), height: pageContentHeight };
}

const DEFAULT_SIZE = 11; // points (Word 2007+ default)

/**
 * Convert twips to pixels (1 twip = 1/1440 inch, 1 inch = 96 CSS px).
 * No rounding — precision prevents cumulative layout drift across paragraphs.
 */
function twipsToPixels(twips: number): number {
  return (twips / 1440) * 96;
}

/**
 * Generate a unique block ID.
 */
let blockIdCounter = 0;
function nextBlockId(): string {
  return `block-${++blockIdCounter}`;
}

function formatNumberedMarker(counters: number[], level: number): string {
  const parts: number[] = [];
  for (let i = 0; i <= level; i += 1) {
    const value = counters[i] ?? 0;
    if (value <= 0) {
      break;
    }
    parts.push(value);
  }
  if (parts.length === 0) {
    return "1.";
  }
  return `${parts.join(".")}.`;
}

const ROMAN_PAIRS: [number, string][] = [
  [1000, "M"],
  [900, "CM"],
  [500, "D"],
  [400, "CD"],
  [100, "C"],
  [90, "XC"],
  [50, "L"],
  [40, "XL"],
  [10, "X"],
  [9, "IX"],
  [5, "V"],
  [4, "IV"],
  [1, "I"],
];

function toRoman(value: number, upper: boolean): string {
  if (value <= 0) {
    return "";
  }
  let remaining = value;
  let output = "";
  for (const [number, symbol] of ROMAN_PAIRS) {
    while (remaining >= number) {
      output += symbol;
      remaining -= number;
    }
  }
  return upper ? output : output.toLowerCase();
}

function toLetter(value: number, upper: boolean): string {
  if (value <= 0) {
    return "";
  }
  const zeroBased = value - 1;
  const baseCodePoint = upper ? 65 : 97;
  const letter = String.fromCodePoint(baseCodePoint + (zeroBased % 26));
  return letter.repeat(Math.floor(zeroBased / 26) + 1);
}

function formatCounter(
  value: number,
  format: NumberFormat | undefined,
): string {
  if (value <= 0) {
    return "";
  }
  // NumberFormat is the OOXML w:numFmt enum (70+ values). This switch
  // handles every format whose counter-rendering differs from a simple
  // decimal; CJK/Hindi/Arabic counters fall through to the decimal
  // default. Matches Word's display when those font glyphs are absent.
  switch (format) {
    case "upperRoman":
      return toRoman(value, true);
    case "lowerRoman":
      return toRoman(value, false);
    case "upperLetter":
      return toLetter(value, true);
    case "lowerLetter":
      return toLetter(value, false);
    case "decimalZero":
      return value < 10 ? `0${value}` : String(value);
    case "none":
      return "";
    default:
      return String(value);
  }
}

function resolveListTemplate(
  template: string,
  counters: number[],
  levelFormats: NumberFormat[] | undefined,
  forceDecimal = false,
): string {
  return template.replace(/%(\d)([.):\]])?/gu, (_match, digit, punct = "") => {
    const index = Number.parseInt(String(digit), 10) - 1;
    if (index < 0) {
      return "";
    }
    const formatted = formatCounter(
      counters[index] ?? 0,
      forceDecimal ? "decimal" : levelFormats?.[index],
    );
    return formatted ? `${formatted}${String(punct)}` : "";
  });
}

function getLastListCounters(
  listCounters: Map<number, number[]>,
): number[] | undefined {
  let lastCounters: number[] | undefined;
  for (const counters of listCounters.values()) {
    lastCounters = counters;
  }
  return lastCounters;
}

function computeListMarker(
  pmAttrs: PMParagraphAttrs,
  listCounters: Map<number, number[]>,
  abstractCounters: Map<number, number[]>,
  seenNumIds: Set<string>,
): string | null {
  const numId = pmAttrs.numPr?.numId;
  if (numId === undefined || numId === 0) {
    if (pmAttrs.listMarker?.includes("%") && !pmAttrs.listIsBullet) {
      const counters = getLastListCounters(listCounters);
      if (counters) {
        return resolveListTemplate(
          pmAttrs.listMarker,
          counters,
          pmAttrs.listLevelNumFmts,
          pmAttrs.listIsLegal,
        );
      }
    }
    return null;
  }

  if (pmAttrs.listIsBullet) {
    return convertBulletToUnicode(pmAttrs.listMarker || "");
  }

  const level = pmAttrs.numPr?.ilvl ?? 0;
  const counters =
    listCounters.get(numId) ?? (Array.from({ length: 9 }, () => 0) as number[]);
  const abstractNumId = pmAttrs.listAbstractNumId;
  if (abstractNumId !== undefined && level > 0) {
    const latestAbstractCounters = abstractCounters.get(abstractNumId);
    const missingParentCounters = counters
      .slice(0, level)
      .every((value) => value === 0);
    if (latestAbstractCounters && missingParentCounters) {
      for (let i = 0; i < level; i += 1) {
        counters[i] = latestAbstractCounters[i] ?? 0;
      }
    }
  }

  const seenKey = `${numId}:${level}`;
  if (!seenNumIds.has(seenKey)) {
    seenNumIds.add(seenKey);
    if (pmAttrs.listStartOverride != null) {
      counters[level] = pmAttrs.listStartOverride - 1;
    }
  }

  counters[level] = (counters[level] ?? 0) + 1;
  for (let i = level + 1; i < counters.length; i += 1) {
    counters[i] = 0;
  }
  listCounters.set(numId, counters);
  if (abstractNumId !== undefined) {
    abstractCounters.set(abstractNumId, [...counters]);
  }

  const levelFormats =
    pmAttrs.listLevelNumFmts ??
    (pmAttrs.listNumFmt ? [pmAttrs.listNumFmt] : undefined);
  if (pmAttrs.listMarker && pmAttrs.listMarker.includes("%")) {
    return resolveListTemplate(
      pmAttrs.listMarker,
      counters,
      levelFormats,
      pmAttrs.listIsLegal,
    );
  }
  if (pmAttrs.listMarker) {
    return pmAttrs.listMarker;
  }
  return formatNumberedMarker(counters, level);
}

/**
 * Reset the block ID counter (useful for testing).
 */
export function resetBlockIdCounter(): void {
  blockIdCounter = 0;
}

/**
 * Extract run formatting from ProseMirror marks.
 */
function extractRunFormatting(
  marks: readonly Mark[],
  theme?: Theme | null,
): RunFormatting {
  const formatting: RunFormatting = {};

  for (const mark of marks) {
    switch (mark.type.name) {
      case "bold":
        formatting.bold = true;
        break;

      case "italic":
        formatting.italic = true;
        break;

      case "underline": {
        const attrs = expectUnderlineMarkAttrs(mark);
        if (attrs.style || attrs.color) {
          const underlineObj: { style?: string; color?: string } = {};
          if (attrs.style) {
            underlineObj.style = attrs.style;
          }
          if (attrs.color) {
            underlineObj.color = resolveColor(attrs.color, theme);
          }
          formatting.underline = underlineObj;
        } else {
          formatting.underline = true;
        }
        break;
      }

      case "strike":
        formatting.strike = true;
        break;

      case "textColor": {
        const attrs = expectTextColorMarkAttrs(mark);
        if (attrs.themeColor || attrs.rgb) {
          const colorArg: ColorValue = {};
          if (attrs.rgb) {
            colorArg.rgb = attrs.rgb;
          }
          if (attrs.themeColor) {
            colorArg.themeColor = attrs.themeColor;
          }
          if (attrs.themeTint) {
            colorArg.themeTint = attrs.themeTint;
          }
          if (attrs.themeShade) {
            colorArg.themeShade = attrs.themeShade;
          }
          if (!isAutomaticTextColorValue(colorArg)) {
            formatting.color = resolveColor(colorArg, theme);
            formatting.textColorSource = "direct";
          }
        }
        break;
      }

      case "highlight":
        formatting.highlight = resolveHighlightToCss(
          expectHighlightMarkAttrs(mark).color,
        );
        break;

      case "fontSize": {
        const attrs = expectFontSizeMarkAttrs(mark);
        // Convert half-points to points
        formatting.fontSize = attrs.size / 2;
        break;
      }

      case "fontFamily": {
        const attrs = expectFontFamilyMarkAttrs(mark);
        const font = attrs.ascii || attrs.hAnsi;
        if (font) {
          formatting.fontFamily = font;
        }
        break;
      }

      case "characterSpacing": {
        const attrs = expectCharacterSpacingMarkAttrs(mark);
        if (attrs.spacing !== undefined && attrs.spacing !== 0) {
          formatting.letterSpacing = twipsToPixels(attrs.spacing);
        }
        if (attrs.position !== undefined && attrs.position !== 0) {
          formatting.positionPx = halfPointsToPixels(attrs.position);
        }
        if (attrs.scale !== undefined && attrs.scale !== 100) {
          formatting.horizontalScale = attrs.scale;
        }
        if (attrs.kerning !== undefined && attrs.kerning > 0) {
          formatting.kerningMinPt = halfPointsToPoints(attrs.kerning);
        }
        break;
      }

      case "allCaps":
        formatting.allCaps = true;
        break;

      case "smallCaps":
        formatting.smallCaps = true;
        break;

      case "emboss":
        formatting.emboss = true;
        break;

      case "imprint":
        formatting.imprint = true;
        break;

      case "hidden":
        // eigenpal #424 (w:vanish gap 9): mark surfaces RunFormatting.hidden
        // so the painter can apply the dimmed dotted-underline treatment.
        formatting.hidden = true;
        break;

      case "textShadow":
        formatting.textShadow = true;
        break;

      case "textOutline":
        formatting.textOutline = true;
        break;

      case "rtl":
        formatting.rtl = true;
        break;

      case "textEffect":
        // The textEffect mark schema rejects "none"; only animated variants
        // ever reach this branch.
        formatting.textEffect = expectTextEffectMarkAttrs(mark).effect;
        break;

      case "runFormattingOverride":
        applyRunFormattingOverrides(
          formatting,
          expectRunFormattingOverrideMarkAttrs(mark),
        );
        break;

      case "emphasisMark": {
        formatting.emphasisMark = expectEmphasisMarkAttrs(mark).type ?? "dot";
        break;
      }

      case "superscript":
        formatting.superscript = true;
        break;

      case "subscript":
        formatting.subscript = true;
        break;

      case "hyperlink": {
        const attrs = expectHyperlinkMarkAttrs(mark);
        const link: RunFormatting["hyperlink"] & object = {
          href: attrs.href,
        };
        if (attrs.tooltip !== undefined) {
          link.tooltip = attrs.tooltip;
        }
        formatting.hyperlink = link;
        break;
      }

      case "footnoteRef": {
        const attrs = expectFootnoteRefMarkAttrs(mark);
        const id =
          typeof attrs.id === "string"
            ? Number.parseInt(attrs.id, 10)
            : attrs.id;
        if (attrs.noteType === "endnote") {
          formatting.endnoteRefId = id;
        } else {
          formatting.footnoteRefId = id;
        }
        break;
      }

      case "comment": {
        const commentId = expectCommentMarkAttrs(mark).commentId;
        if (commentId) {
          if (!formatting.commentIds) {
            formatting.commentIds = [];
          }
          formatting.commentIds.push(commentId);
        }
        break;
      }

      case "insertion": {
        const attrs = expectTrackedChangeMarkAttrs(mark);
        formatting.isInsertion = true;
        formatting.changeAuthor = attrs.author;
        if (attrs.date !== undefined) {
          formatting.changeDate = attrs.date;
        }
        formatting.changeRevisionId = attrs.revisionId;
        break;
      }

      case "deletion": {
        const attrs = expectTrackedChangeMarkAttrs(mark);
        formatting.isDeletion = true;
        formatting.changeAuthor = attrs.author;
        if (attrs.date !== undefined) {
          formatting.changeDate = attrs.date;
        }
        formatting.changeRevisionId = attrs.revisionId;
        break;
      }
      default:
        break;
    }
  }

  return formatting;
}

function isAutomaticTextColorValue(color: ColorValue): boolean {
  const rgb = color.rgb?.trim().toLowerCase();
  return color.auto === true || rgb === "auto" || (!rgb && !color.themeColor);
}

function markDefaultBlackTextColorSource(
  formatting: RunFormatting,
  paraDefaults: RunFormatting,
): RunFormatting {
  if (
    formatting.textColorSource === "direct" ||
    formatting.color === undefined ||
    paraDefaults.color === undefined ||
    !isDefaultBlackResolvedTextColor(formatting.color) ||
    !areResolvedTextColorsEqual(formatting.color, paraDefaults.color)
  ) {
    return formatting;
  }

  return {
    ...formatting,
    textColorSource: "paragraphDefault",
  };
}

function mergeRunFormatting(
  paraDefaults: RunFormatting,
  formatting: RunFormatting,
): RunFormatting {
  return {
    ...paraDefaults,
    ...markDefaultBlackTextColorSource(formatting, paraDefaults),
  };
}

function applyRunFormattingOverrides(
  formatting: RunFormatting,
  attrs: RunFormattingOverrideAttrs,
): void {
  if (attrs.bold === false) {
    formatting.bold = false;
  }
  if (attrs.italic === false) {
    formatting.italic = false;
  }
  if (attrs.underline === "none") {
    formatting.underline = false;
  }
  if (attrs.strike === false) {
    formatting.strike = false;
  }
  if (attrs.allCaps === false) {
    formatting.allCaps = false;
  }
  if (attrs.smallCaps === false) {
    formatting.smallCaps = false;
  }
  if (attrs.emboss === false) {
    formatting.emboss = false;
  }
  if (attrs.imprint === false) {
    formatting.imprint = false;
  }
  if (attrs.shadow === false) {
    formatting.textShadow = false;
  }
  if (attrs.outline === false) {
    formatting.textOutline = false;
  }
  if (attrs.rtl === false) {
    formatting.rtl = false;
  }
}

function paragraphRunDefaults(
  pmAttrs: PMParagraphAttrs,
  theme?: Theme | null,
): RunFormatting {
  const defaultTextFormatting = pmAttrs.defaultTextFormatting as
    | TextFormatting
    | undefined;
  if (!defaultTextFormatting) {
    return {};
  }

  const result: RunFormatting = {};
  const fontFamily =
    defaultTextFormatting.fontFamily?.ascii ??
    defaultTextFormatting.fontFamily?.hAnsi;
  if (fontFamily) {
    result.fontFamily = fontFamily;
  }
  if (defaultTextFormatting.fontSize !== undefined) {
    result.fontSize = defaultTextFormatting.fontSize / 2;
  }
  if (defaultTextFormatting.bold !== undefined) {
    result.bold = defaultTextFormatting.bold;
  }
  if (defaultTextFormatting.italic !== undefined) {
    result.italic = defaultTextFormatting.italic;
  }
  if (
    defaultTextFormatting.underline &&
    defaultTextFormatting.underline.style !== "none"
  ) {
    result.underline = { style: defaultTextFormatting.underline.style };
    if (defaultTextFormatting.underline.color) {
      result.underline.color = resolveColor(
        defaultTextFormatting.underline.color,
        theme,
      );
    }
  }
  if (defaultTextFormatting.strike !== undefined) {
    result.strike = defaultTextFormatting.strike;
  }
  if (
    defaultTextFormatting.color &&
    !isAutomaticTextColorValue(defaultTextFormatting.color)
  ) {
    result.color = resolveColor(defaultTextFormatting.color, theme);
    result.textColorSource = "paragraphDefault";
  }
  if (defaultTextFormatting.highlight) {
    const highlight = resolveHighlightToCss(defaultTextFormatting.highlight);
    if (highlight) {
      result.highlight = highlight;
    }
  }
  if (defaultTextFormatting.vertAlign === "superscript") {
    result.superscript = true;
  }
  if (defaultTextFormatting.vertAlign === "subscript") {
    result.subscript = true;
  }
  if (defaultTextFormatting.allCaps !== undefined) {
    result.allCaps = defaultTextFormatting.allCaps;
  }
  if (defaultTextFormatting.smallCaps !== undefined) {
    result.smallCaps = defaultTextFormatting.smallCaps;
  }
  if (
    defaultTextFormatting.spacing !== undefined &&
    defaultTextFormatting.spacing !== 0
  ) {
    result.letterSpacing = twipsToPixels(defaultTextFormatting.spacing);
  }
  if (
    defaultTextFormatting.position !== undefined &&
    defaultTextFormatting.position !== 0
  ) {
    result.positionPx = halfPointsToPixels(defaultTextFormatting.position);
  }
  if (
    defaultTextFormatting.scale !== undefined &&
    defaultTextFormatting.scale !== 100
  ) {
    result.horizontalScale = defaultTextFormatting.scale;
  }
  if (
    defaultTextFormatting.kerning !== undefined &&
    defaultTextFormatting.kerning > 0
  ) {
    result.kerningMinPt = halfPointsToPoints(defaultTextFormatting.kerning);
  }
  if (defaultTextFormatting.emboss !== undefined) {
    result.emboss = defaultTextFormatting.emboss;
  }
  if (defaultTextFormatting.imprint !== undefined) {
    result.imprint = defaultTextFormatting.imprint;
  }
  if (defaultTextFormatting.shadow !== undefined) {
    result.textShadow = defaultTextFormatting.shadow;
  }
  if (defaultTextFormatting.outline !== undefined) {
    result.textOutline = defaultTextFormatting.outline;
  }
  if (
    defaultTextFormatting.emphasisMark &&
    defaultTextFormatting.emphasisMark !== "none"
  ) {
    result.emphasisMark = defaultTextFormatting.emphasisMark;
  }
  return result;
}

/**
 * Build an ImageRun from ProseMirror node attrs, applying conditional property assignment
 * to satisfy exactOptionalPropertyTypes.
 */
function buildImageRun(
  attrs: ImageAttrs,
  constrained: { width: number; height: number },
  pmStart: number,
  pmEnd: number,
  // Tracked-change attrs lifted off the image node's PM marks. eigenpal #641.
  trackedChange?: Pick<
    RunFormatting,
    | "isInsertion"
    | "isDeletion"
    | "changeAuthor"
    | "changeDate"
    | "changeRevisionId"
  >,
): ImageRun {
  const run: ImageRun = {
    kind: "image",
    src: attrs.src,
    width: constrained.width,
    height: constrained.height,
    pmStart,
    pmEnd,
  };
  if (attrs.alt !== undefined) {
    run.alt = attrs.alt;
  }
  if (attrs.transform !== undefined) {
    run.transform = attrs.transform;
  }
  // eigenpal #424 (opacity render pipeline): copy opacity verbatim. PM
  // schema defaults `opacity` to `null`, which survives the typed cast on
  // ImageAttrs (`number | undefined`). Gate with `!= null` so the model
  // never carries the schema sentinel.
  if (attrs.opacity != null) {
    run.opacity = attrs.opacity;
  }
  if (attrs.wrapType !== undefined) {
    run.wrapType = attrs.wrapType;
  }
  if (attrs.displayMode !== undefined) {
    run.displayMode = attrs.displayMode;
  }
  if (attrs.cssFloat !== undefined) {
    run.cssFloat = attrs.cssFloat;
  }
  if (attrs.distTop !== undefined) {
    run.distTop = attrs.distTop;
  }
  if (attrs.distBottom !== undefined) {
    run.distBottom = attrs.distBottom;
  }
  if (attrs.distLeft !== undefined) {
    run.distLeft = attrs.distLeft;
  }
  if (attrs.distRight !== undefined) {
    run.distRight = attrs.distRight;
  }
  // eigenpal #424: pass crop fractions through to the painter so it can
  // emit CSS clip-path. PM defaults are `null`; treat null as "not set".
  if (attrs.cropTop != null) {
    run.cropTop = attrs.cropTop;
  }
  if (attrs.cropRight != null) {
    run.cropRight = attrs.cropRight;
  }
  if (attrs.cropBottom != null) {
    run.cropBottom = attrs.cropBottom;
  }
  if (attrs.cropLeft != null) {
    run.cropLeft = attrs.cropLeft;
  }
  if (attrs.position !== undefined) {
    run.position = attrs.position;
  }
  if (trackedChange?.isInsertion) {
    run.isInsertion = true;
  }
  if (trackedChange?.isDeletion) {
    run.isDeletion = true;
  }
  if (trackedChange?.changeAuthor !== undefined) {
    run.changeAuthor = trackedChange.changeAuthor;
  }
  if (trackedChange?.changeDate !== undefined) {
    run.changeDate = trackedChange.changeDate;
  }
  if (trackedChange?.changeRevisionId !== undefined) {
    run.changeRevisionId = trackedChange.changeRevisionId;
  }
  return run;
}

/**
 * Paragraph styleId pattern used by Word for TOC entries (TOC, TOC1, TOC2, …).
 * Hyperlinks inside these paragraphs must render in the paragraph's own colour,
 * not the Hyperlink character style — see {@link stripTocHyperlinkStyle}.
 */
const TOC_STYLE_ID = /^TOC\d*$/iu;

/**
 * In TOC paragraphs, strip the resolved Hyperlink character-style colour and
 * underline so the painter's link fallback doesn't fire. The PM doc keeps the
 * original marks so copy/paste out of a TOC still carries the Hyperlink
 * styling like Word does. Applies to both text and field runs — a TOC entry's
 * page number is a PAGEREF field inside the entry's hyperlink.
 *
 * Mutates `formatting` in place; cheaper than re-cloning per run.
 */
function stripTocHyperlinkStyle(formatting: RunFormatting): void {
  if (!formatting.hyperlink) {
    return;
  }
  formatting.hyperlink = { ...formatting.hyperlink, noDefaultStyle: true };
  delete formatting.color;
  delete formatting.underline;
}

/**
 * Convert a paragraph node to runs.
 */
function paragraphToRuns(
  node: PMNode,
  startPos: number,
  _options: ToFlowBlocksOptions,
): Run[] {
  const runs: Run[] = [];
  const offset = startPos + 1; // +1 for opening tag
  const theme = _options.theme;
  const pmAttrs = expectParagraphAttrs(node);
  const paraDefaults = paragraphRunDefaults(pmAttrs, theme);
  const paragraphStyleId = pmAttrs.styleId;
  const inTocParagraph =
    typeof paragraphStyleId === "string" && TOC_STYLE_ID.test(paragraphStyleId);

  // Single dispatcher for one inline PM child. Recurses on `sdt` so nested
  // content controls keep contributing runs at the right pmStart/pmEnd.
  // Used for both the top-level paragraph iteration and the descent into
  // SDT children — the previous SDT branch only handled text/hardBreak/
  // tab/image and silently dropped fields, math, and nested SDTs even
  // when the parser preserved them (see eigenpal #482).
  function pushRunsForChild(child: PMNode, childPos: number): void {
    if (child.isText && child.text) {
      const formatting = extractRunFormatting(child.marks, theme);
      if (inTocParagraph) {
        stripTocHyperlinkStyle(formatting);
      }
      const run: TextRun = {
        kind: "text",
        text: child.text,
        ...mergeRunFormatting(paraDefaults, formatting),
        pmStart: childPos,
        pmEnd: childPos + child.nodeSize,
      };
      runs.push(run);
      return;
    }
    if (child.type.name === "hardBreak") {
      runs.push({
        kind: "lineBreak",
        pmStart: childPos,
        pmEnd: childPos + child.nodeSize,
      });
      return;
    }
    if (child.type.name === "tab") {
      const formatting = extractRunFormatting(child.marks, theme);
      const run: TabRun = {
        kind: "tab",
        ...mergeRunFormatting(paraDefaults, formatting),
        pmStart: childPos,
        pmEnd: childPos + child.nodeSize,
      };
      runs.push(run);
      return;
    }
    if (child.type.name === "image") {
      const attrs = expectImageAttrs(child);
      const constrained = constrainImageToPage(
        attrs.width || 100,
        attrs.height || 100,
        _options.pageContentHeight,
      );
      // Lift tracked-change marks off the image node so an inserted/deleted
      // picture paints in the revision colour and resolves with the rest of
      // the change. eigenpal #641.
      const trackedFmt = extractRunFormatting(child.marks, theme);
      const run = buildImageRun(
        attrs,
        constrained,
        childPos,
        childPos + child.nodeSize,
        trackedFmt,
      );
      runs.push(run);
      return;
    }
    if (child.type.name === "field") {
      // Marks on the field node (bold/italic/underline applied to the
      // field result inside `<w:fldChar separate>...</w:fldChar end>`)
      // must propagate to the run formatting, otherwise complex REF
      // fields whose visible text was authored as underlined (e.g.
      // cross-references like "Exhibit A" / "Section 1.3" in NVCA-style
      // templates) render with no underline. Reuse the same extractor
      // text runs use.
      const attrs = expectFieldAttrs(child);
      const ft = attrs.fieldType;
      let mappedType: FieldRun["fieldType"] = "OTHER";
      if (ft === "PAGE") {
        mappedType = "PAGE";
      } else if (ft === "NUMPAGES") {
        mappedType = "NUMPAGES";
      } else if (ft === "DATE") {
        mappedType = "DATE";
      } else if (ft === "TIME") {
        mappedType = "TIME";
      }
      const extractedFieldFormatting = extractRunFormatting(child.marks, theme);
      if (inTocParagraph) {
        stripTocHyperlinkStyle(extractedFieldFormatting);
      }
      const fieldFormatting = markDefaultBlackTextColorSource(
        extractedFieldFormatting,
        paraDefaults,
      );
      const run: FieldRun = {
        kind: "field",
        fieldType: mappedType,
        fallback: attrs.displayText || "",
        pmStart: childPos,
        pmEnd: childPos + child.nodeSize,
        ...fieldFormatting,
      };
      runs.push(run);
      return;
    }
    if (child.type.name === "math") {
      const text = expectMathAttrs(child).plainText || "[equation]";
      runs.push({
        kind: "text",
        text,
        italic: true,
        fontFamily: "Cambria Math",
        pmStart: childPos,
        pmEnd: childPos + child.nodeSize,
      });
      return;
    }
    if (child.type.name === "sdt") {
      const sdtInnerOffset = childPos + 1; // +1 for opening tag
      // oxlint-disable-next-line unicorn/no-array-for-each -- ProseMirror Node.forEach
      child.forEach((sdtChild, sdtChildOffset) => {
        pushRunsForChild(sdtChild, sdtInnerOffset + sdtChildOffset);
      });
    }
  }

  // oxlint-disable-next-line unicorn/no-array-for-each -- ProseMirror Node.forEach
  node.forEach((child, childOffset) => {
    pushRunsForChild(child, offset + childOffset);
  });

  return runs;
}

/**
 * Convert PM paragraph attrs to layout engine paragraph attrs.
 */
function convertParagraphAttrs(
  pmAttrs: PMParagraphAttrs,
  theme?: Theme | null,
  listCounters?: Map<number, number[]>,
  listAbstractCounters?: Map<number, number[]>,
  listSeenNumIds?: Set<string>,
  defaultTabStopTwips?: number,
): ParagraphAttrs {
  const attrs: ParagraphAttrs = {};

  // Alignment - map DOCX values to CSS-compatible values
  // DOCX uses 'both' for justify, 'distribute' for distributed justify
  if (pmAttrs.alignment) {
    const align = pmAttrs.alignment;
    if (align === "both" || align === "distribute") {
      attrs.alignment = "justify";
    } else if (align === "left") {
      attrs.alignment = "left";
    } else if (align === "center") {
      attrs.alignment = "center";
    } else if (align === "right") {
      attrs.alignment = "right";
    }
    // Other DOCX alignments (mediumKashida, highKashida, lowKashida, thaiDistribute, justify)
    // default to no alignment set (inherits from style or defaults to left)
  }

  // Spacing
  const spaceBefore = pmAttrs.spaceBefore;
  const spaceAfter = pmAttrs.spaceAfter;
  const lineSpacing = pmAttrs.lineSpacing;
  if (
    typeof spaceBefore === "number" ||
    typeof spaceAfter === "number" ||
    typeof lineSpacing === "number"
  ) {
    attrs.spacing = {};
    if (typeof spaceBefore === "number") {
      attrs.spacing.before = twipsToPixels(spaceBefore);
    }
    if (typeof spaceAfter === "number") {
      attrs.spacing.after = twipsToPixels(spaceAfter);
    }
    // Propagate the `spacingExplicit` flag the PM schema carries — empty
    // paragraphs inherit zero spacing unless the side was set inline (Word
    // fidelity, eigenpal #402).
    const pmSpacingExplicit = pmAttrs.spacingExplicit as
      | { before?: boolean; after?: boolean }
      | null
      | undefined;
    if (pmSpacingExplicit) {
      const explicit: { before?: boolean; after?: boolean } = {};
      if (pmSpacingExplicit.before) {
        explicit.before = true;
      }
      if (pmSpacingExplicit.after) {
        explicit.after = true;
      }
      if (explicit.before !== undefined || explicit.after !== undefined) {
        attrs.spacingExplicit = explicit;
      }
    }
    if (typeof lineSpacing === "number") {
      // Line spacing in twips - convert to multiplier or exact
      if (
        pmAttrs.lineSpacingRule === "exact" ||
        pmAttrs.lineSpacingRule === "atLeast"
      ) {
        attrs.spacing.line = twipsToPixels(lineSpacing);
        attrs.spacing.lineUnit = "px";
        attrs.spacing.lineRule = pmAttrs.lineSpacingRule;
      } else {
        // Auto - line spacing is in 240ths of a line
        attrs.spacing.line = lineSpacing / 240;
        attrs.spacing.lineUnit = "multiplier";
        attrs.spacing.lineRule = "auto";
      }
    }
  }

  // Indentation - handle list item fallback calculation
  // For list items without explicit indentation, calculate based on level
  let indentLeft =
    typeof pmAttrs.indentLeft === "number" ? pmAttrs.indentLeft : undefined;
  let indentFirstLine =
    typeof pmAttrs.indentFirstLine === "number"
      ? pmAttrs.indentFirstLine
      : undefined;
  let hangingIndent = pmAttrs.hangingIndent;
  if (pmAttrs.numPr?.numId && indentLeft === undefined) {
    // Fallback: calculate indentation based on level
    // Each level indents 0.5 inch (720 twips) more
    const level = pmAttrs.numPr.ilvl ?? 0;
    // Base indentation: 0.5 inch (720 twips) per level
    // Level 0 = 720 twips, Level 1 = 1440 twips, etc.
    indentLeft = (level + 1) * 720;
    // Default hanging indent of 360 twips for the list marker
    if (indentFirstLine === undefined) {
      indentFirstLine = -360;
      hangingIndent = true;
    }
  }

  if (
    indentLeft !== undefined ||
    typeof pmAttrs.indentRight === "number" ||
    indentFirstLine !== undefined
  ) {
    attrs.indent = {};
    if (indentLeft !== undefined) {
      attrs.indent.left = twipsToPixels(indentLeft);
    }
    if (typeof pmAttrs.indentRight === "number") {
      attrs.indent.right = twipsToPixels(pmAttrs.indentRight);
    }
    if (indentFirstLine !== undefined) {
      if (hangingIndent) {
        // Hanging indent: indentFirstLine is stored as negative, convert to positive for rendering
        attrs.indent.hanging = Math.abs(twipsToPixels(indentFirstLine));
      } else {
        attrs.indent.firstLine = twipsToPixels(indentFirstLine);
      }
    }
  }

  // Style ID
  if (pmAttrs.styleId) {
    attrs.styleId = pmAttrs.styleId;
  }

  // Borders
  if (pmAttrs.borders) {
    const borders = pmAttrs.borders;
    attrs.borders = {};

    const convertBorder = (border: typeof borders.top) =>
      border ? convertBorderSpecToLayout(border, theme) : undefined;

    const topBorder = borders.top ? convertBorder(borders.top) : undefined;
    if (topBorder) {
      attrs.borders.top = topBorder;
    }
    const bottomBorder = borders.bottom
      ? convertBorder(borders.bottom)
      : undefined;
    if (bottomBorder) {
      attrs.borders.bottom = bottomBorder;
    }
    const leftBorder = borders.left ? convertBorder(borders.left) : undefined;
    if (leftBorder) {
      attrs.borders.left = leftBorder;
    }
    const rightBorder = borders.right
      ? convertBorder(borders.right)
      : undefined;
    if (rightBorder) {
      attrs.borders.right = rightBorder;
    }
    const betweenBorder = borders.between
      ? convertBorder(borders.between)
      : undefined;
    if (betweenBorder) {
      attrs.borders.between = betweenBorder;
    }
    const barBorder = borders.bar ? convertBorder(borders.bar) : undefined;
    if (barBorder) {
      attrs.borders.bar = barBorder;
    }

    // Only include if at least one border is set
    if (
      !attrs.borders.top &&
      !attrs.borders.bottom &&
      !attrs.borders.left &&
      !attrs.borders.right &&
      !attrs.borders.between &&
      !attrs.borders.bar
    ) {
      delete attrs.borders;
    }
  }

  // Shading (background color). Word's `Normal` paragraph style commonly
  // sets `<w:shd val="clear" fill="FFFFFF"/>` — semantically a no-op on
  // a white page, but folio's dark mode draws the literal `#FFFFFF`
  // fill as a visible white block over the dark canvas. Treat any white
  // shading as transparent (= page background) so it renders the same as
  // "no shading" in both modes. Other shading colors are preserved
  // verbatim so authored highlights stay visible.
  const shadingRgb = pmAttrs.shading?.fill?.rgb?.toUpperCase();
  if (shadingRgb && shadingRgb !== "FFFFFF" && shadingRgb !== "FFFFFE") {
    attrs.shading = `#${pmAttrs.shading?.fill?.rgb}`;
  }

  // Tab stops
  if (pmAttrs.tabs && pmAttrs.tabs.length > 0) {
    attrs.tabs = pmAttrs.tabs.map((tab) => {
      const tabStop: TabStop = {
        val: mapTabAlignment(tab.alignment),
        pos: tab.position,
      };
      if (tab.leader) {
        tabStop.leader = tab.leader as NonNullable<TabStop["leader"]>;
      }
      return tabStop;
    });
  }

  // Page break control
  if (pmAttrs.pageBreakBefore) {
    attrs.pageBreakBefore = true;
  }
  if (pmAttrs.keepNext) {
    attrs.keepNext = true;
  }
  if (pmAttrs.keepLines) {
    attrs.keepLines = true;
  }
  if (pmAttrs.contextualSpacing) {
    attrs.contextualSpacing = true;
  }
  if (pmAttrs.runInWithNext) {
    attrs.runInWithNext = true;
  }
  if (pmAttrs.bidi) {
    attrs.bidi = true;
  }
  if (pmAttrs.styleId) {
    attrs.styleId = pmAttrs.styleId;
  }

  // List properties
  if (pmAttrs.numPr) {
    const numPr: ParagraphAttrs["numPr"] & object = {};
    if (pmAttrs.numPr.numId !== undefined) {
      numPr.numId = pmAttrs.numPr.numId;
    }
    if (pmAttrs.numPr.ilvl !== undefined) {
      numPr.ilvl = pmAttrs.numPr.ilvl;
    }
    attrs.numPr = numPr;
  }
  const resolvedMarker = listCounters
    ? computeListMarker(
        pmAttrs,
        listCounters,
        listAbstractCounters ?? new Map(),
        listSeenNumIds ?? new Set(),
      )
    : null;
  if (resolvedMarker !== null) {
    attrs.listMarker = resolvedMarker;
  } else if (pmAttrs.listMarker) {
    attrs.listMarker = pmAttrs.listIsBullet
      ? convertBulletToUnicode(pmAttrs.listMarker)
      : pmAttrs.listMarker;
  }
  if (pmAttrs.listIsBullet !== undefined) {
    attrs.listIsBullet = pmAttrs.listIsBullet;
  }
  if (pmAttrs.listMarkerHidden) {
    attrs.listMarkerHidden = true;
  }
  if (pmAttrs.listMarkerFontFamily) {
    attrs.listMarkerFontFamily = pmAttrs.listMarkerFontFamily;
  }
  if (pmAttrs.listMarkerFontSize) {
    attrs.listMarkerFontSize = pmAttrs.listMarkerFontSize;
  }
  if (pmAttrs.listMarkerSuffix) {
    attrs.listMarkerSuffix = pmAttrs.listMarkerSuffix;
  }
  if (defaultTabStopTwips !== undefined) {
    attrs.defaultTabStopTwips = defaultTabStopTwips;
  }

  // Default font for empty paragraph measurement (from style's rPr / pPr/rPr)
  const dtf = pmAttrs.defaultTextFormatting as
    | { fontSize?: number; fontFamily?: { ascii?: string; hAnsi?: string } }
    | undefined;
  if (dtf) {
    if (dtf.fontSize !== undefined) {
      // fontSize in TextFormatting is in half-points, convert to points
      attrs.defaultFontSize = dtf.fontSize / 2;
    }
    if (dtf.fontFamily) {
      const resolvedFamily = dtf.fontFamily.ascii || dtf.fontFamily.hAnsi;
      if (resolvedFamily) {
        attrs.defaultFontFamily = resolvedFamily;
      }
    }
  }

  return attrs;
}

/**
 * Map document TabStopAlignment to layout engine TabAlignment
 */
function mapTabAlignment(
  align: "left" | "center" | "right" | "decimal" | "bar" | "clear" | "num",
): "start" | "end" | "center" | "decimal" | "bar" | "clear" {
  switch (align) {
    case "left":
      return "start";
    case "right":
      return "end";
    case "center":
      return "center";
    case "decimal":
      return "decimal";
    case "bar":
      return "bar";
    case "clear":
      return "clear";
    case "num":
      return "start"; // Number tab treated as left-aligned
    default:
      return "start";
  }
}

/**
 * Convert a paragraph node to a ParagraphBlock.
 */
function convertParagraph(
  node: PMNode,
  startPos: number,
  options: ToFlowBlocksOptions,
): ParagraphBlock {
  const pmAttrs = expectParagraphAttrs(node);
  const runs = paragraphToRuns(node, startPos, options);
  const attrs = convertParagraphAttrs(
    pmAttrs,
    options.theme,
    options.listCounters,
    options.listAbstractCounters,
    options.listSeenNumIds,
    options.defaultTabStopTwips,
  );

  return {
    kind: "paragraph",
    id: nextBlockId(),
    runs,
    attrs,
    pmStart: startPos,
    pmEnd: startPos + node.nodeSize,
  };
}

/**
 * Convert border width from eighths of a point to pixels.
 * OOXML stores border widths in eighths of a point.
 */
function borderWidthToPixels(eighthsOfPoint: number): number {
  // 1 point = 1.333 pixels at 96 DPI
  // eighths of a point: divide by 8 first
  return Math.max(1, Math.round((eighthsOfPoint / 8) * 1.333));
}

// OOXML border style → CSS border-style mapping
const OOXML_TO_CSS_BORDER: Record<string, string> = {
  single: "solid",
  double: "double",
  dotted: "dotted",
  dashed: "dashed",
  thick: "solid",
  dashSmallGap: "dashed",
  dotDash: "dashed",
  dotDotDash: "dotted",
  triple: "double",
  wave: "solid",
  doubleWave: "double",
  threeDEmboss: "ridge",
  threeDEngrave: "groove",
  outset: "outset",
  inset: "inset",
};

/**
 * Convert an OOXML BorderSpec to a layout-engine BorderStyle.
 * Shared by paragraph borders, cell borders, and header/footer borders.
 */
export function convertBorderSpecToLayout(
  border: {
    style?: string;
    size?: number;
    space?: number;
    color?: {
      rgb?: string;
      themeColor?: string;
      themeTint?: string;
      themeShade?: string;
    };
  },
  theme?: Theme | null,
): BorderStyle | undefined {
  if (!border.style || border.style === "none" || border.style === "nil") {
    return undefined;
  }
  const result: BorderStyle = {
    style: OOXML_TO_CSS_BORDER[border.style] || "solid",
    width: borderWidthToPixels(border.size ?? 0),
    color: border.color
      ? resolveColor(border.color as Parameters<typeof resolveColor>[0], theme)
      : "#000000",
  };
  if (border.space !== undefined) {
    result.space = pointsToPixels(border.space);
  }
  return result;
}

/**
 * Extract cell borders from ProseMirror attributes.
 * Borders are full BorderSpec objects with style/size/color.
 */
function extractCellBorders(
  borders:
    | Record<
        string,
        {
          style?: string;
          size?: number;
          color?: {
            rgb?: string;
            themeColor?: string;
            themeTint?: string;
            themeShade?: string;
          };
        }
      >
    | null
    | undefined,
  theme?: Theme | null,
): CellBorders | undefined {
  if (!borders) {
    return undefined;
  }

  const result: CellBorders = {};
  const sides = ["top", "bottom", "left", "right"] as const;

  for (const side of sides) {
    const border = borders[side];
    const converted = border
      ? convertBorderSpecToLayout(border, theme)
      : undefined;
    result[side] = converted ?? { width: 0, style: "none" };
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Convert a table cell node.
 */
function convertTableCell(
  node: PMNode,
  startPos: number,
  options: ToFlowBlocksOptions,
  tableCellMargins?: {
    top?: number;
    bottom?: number;
    left?: number;
    right?: number;
  },
): TableCell {
  const blocks: FlowBlock[] = [];
  let offset = startPos + 1; // +1 for opening tag

  // oxlint-disable-next-line unicorn/no-array-for-each -- ProseMirror Node.forEach
  node.forEach((child) => {
    if (child.type.name === "paragraph") {
      const block = convertParagraph(child, offset, options);
      blocks.push(block);
    } else if (child.type.name === "table") {
      blocks.push(convertTable(child, offset, options));
    }
    offset += child.nodeSize;
  });

  const attrs = expectTableCellAttrs(node);

  // Convert cell margins (twips) to pixel padding
  // OOXML TableNormal defaults: top=0, bottom=0, left=108 twips (~7px), right=108 twips (~7px)
  const margins = attrs.margins;
  const resolvePaddingSide = (
    side: TablePaddingSide,
    cellTwips: number | undefined,
    tableTwips: number | undefined,
  ): number => {
    if (cellTwips !== undefined) {
      const px = twipsToPixels(cellTwips);
      if (px > 0) {
        return px;
      }
    }
    if (tableTwips !== undefined) {
      return twipsToPixels(tableTwips);
    }
    return twipsToPixels(DEFAULT_TABLE_CELL_MARGIN_TWIPS[side]);
  };
  const padding = {
    top: resolvePaddingSide("top", margins?.top, tableCellMargins?.top),
    right: resolvePaddingSide("right", margins?.right, tableCellMargins?.right),
    bottom: resolvePaddingSide(
      "bottom",
      margins?.bottom,
      tableCellMargins?.bottom,
    ),
    left: resolvePaddingSide("left", margins?.left, tableCellMargins?.left),
  };

  const cell: TableCell = {
    id: nextBlockId(),
    blocks,
    colSpan: attrs.colspan,
    rowSpan: attrs.rowspan,
    padding,
  };
  if (attrs.width) {
    cell.width = twipsToPixels(attrs.width);
  }
  if (attrs.verticalAlign) {
    cell.verticalAlign = attrs.verticalAlign;
  }
  if (attrs.backgroundColor) {
    cell.background = `#${attrs.backgroundColor}`;
  }
  const cellBorders = extractCellBorders(attrs.borders, options.theme);
  if (cellBorders) {
    cell.borders = cellBorders;
  }
  if (attrs.noWrap) {
    cell.noWrap = true;
  }
  return cell;
}

/**
 * Convert a table row node.
 */
function convertTableRow(
  node: PMNode,
  startPos: number,
  options: ToFlowBlocksOptions,
  tableCellMargins?: {
    top?: number;
    bottom?: number;
    left?: number;
    right?: number;
  },
): TableRow {
  const cells: TableCell[] = [];
  let offset = startPos + 1; // +1 for opening tag

  // oxlint-disable-next-line unicorn/no-array-for-each -- ProseMirror Node.forEach
  node.forEach((child) => {
    if (child.type.name === "tableCell" || child.type.name === "tableHeader") {
      cells.push(convertTableCell(child, offset, options, tableCellMargins));
    }
    offset += child.nodeSize;
  });

  const attrs = expectTableRowAttrs(node);
  const row: TableRow = {
    id: nextBlockId(),
    cells,
  };
  if (attrs.height) {
    row.height = twipsToPixels(attrs.height);
  }
  if (attrs.heightRule) {
    row.heightRule = attrs.heightRule;
  }
  if (attrs.isHeader) {
    row.isHeader = attrs.isHeader;
  }
  return row;
}

/**
 * Convert a table node to a TableBlock.
 */
function convertTable(
  node: PMNode,
  startPos: number,
  options: ToFlowBlocksOptions,
): TableBlock {
  const rows: TableRow[] = [];
  let offset = startPos + 1; // +1 for opening tag
  const attrs = expectTableAttrs(node);
  const tableCellMargins = attrs.cellMargins;

  // oxlint-disable-next-line unicorn/no-array-for-each -- ProseMirror Node.forEach
  node.forEach((child) => {
    if (child.type.name === "tableRow") {
      rows.push(convertTableRow(child, offset, options, tableCellMargins));
    }
    offset += child.nodeSize;
  });

  // Extract columnWidths from node attributes and convert from twips to pixels
  const columnWidthsTwips = attrs.columnWidths;
  let columnWidths = columnWidthsTwips?.map(twipsToPixels);

  const width = attrs.width;
  const widthType = attrs.widthType;

  // Fallback: compute column widths from first row cell widths if table attr is missing
  if (!columnWidths && rows.length > 0) {
    // SAFETY: rows.length > 0 verified by condition above
    const firstRow = rows[0]!;
    const cellWidths = firstRow.cells.map((cell) => cell.width);
    // Only use if all cells have widths defined
    if (cellWidths.every((w) => w !== undefined && w > 0)) {
      columnWidths = cellWidths as number[];
    }
  }

  // Extract justification
  const justification = attrs.justification;

  // Extract table indent from _originalFormatting (w:tblInd)
  const originalFormatting = attrs._originalFormatting as
    | { indent?: { value: number; type: string } }
    | undefined;
  const indentPx =
    originalFormatting?.indent?.value &&
    originalFormatting.indent.type === "dxa"
      ? twipsToPixels(originalFormatting.indent.value)
      : undefined;

  const floating = attrs.floating as
    | {
        horzAnchor?: "margin" | "page" | "text";
        vertAnchor?: "margin" | "page" | "text";
        tblpX?: number;
        tblpXSpec?: "left" | "center" | "right" | "inside" | "outside";
        tblpY?: number;
        tblpYSpec?:
          | "top"
          | "center"
          | "bottom"
          | "inside"
          | "outside"
          | "inline";
        topFromText?: number;
        bottomFromText?: number;
        leftFromText?: number;
        rightFromText?: number;
      }
    | undefined;

  let floatingPx: FloatingTablePosition | undefined;
  if (floating) {
    const fp: FloatingTablePosition = {};
    if (floating.horzAnchor) {
      fp.horzAnchor = floating.horzAnchor;
    }
    if (floating.vertAnchor) {
      fp.vertAnchor = floating.vertAnchor;
    }
    if (floating.tblpX !== undefined) {
      fp.tblpX = twipsToPixels(floating.tblpX);
    }
    if (floating.tblpXSpec) {
      fp.tblpXSpec = floating.tblpXSpec;
    }
    if (floating.tblpY !== undefined) {
      fp.tblpY = twipsToPixels(floating.tblpY);
    }
    if (floating.tblpYSpec) {
      fp.tblpYSpec = floating.tblpYSpec;
    }
    if (floating.topFromText !== undefined) {
      fp.topFromText = twipsToPixels(floating.topFromText);
    }
    if (floating.bottomFromText !== undefined) {
      fp.bottomFromText = twipsToPixels(floating.bottomFromText);
    }
    if (floating.leftFromText !== undefined) {
      fp.leftFromText = twipsToPixels(floating.leftFromText);
    }
    if (floating.rightFromText !== undefined) {
      fp.rightFromText = twipsToPixels(floating.rightFromText);
    }
    floatingPx = fp;
  }

  const tableBlock: TableBlock = {
    kind: "table",
    id: nextBlockId(),
    rows,
    pmStart: startPos,
    pmEnd: startPos + node.nodeSize,
  };
  if (columnWidths) {
    tableBlock.columnWidths = columnWidths;
  }
  if (width !== undefined) {
    tableBlock.width = width;
  }
  if (widthType !== undefined) {
    tableBlock.widthType = widthType;
  }
  if (justification) {
    tableBlock.justification = justification;
  }
  if (indentPx !== undefined) {
    tableBlock.indent = indentPx;
  }
  if (floatingPx) {
    tableBlock.floating = floatingPx;
  }
  return tableBlock;
}

/**
 * Convert an image node to an ImageBlock.
 */
function convertImage(
  node: PMNode,
  startPos: number,
  pageContentHeight?: number,
): ImageBlock {
  const attrs = expectImageAttrs(node);
  const wrapType = attrs.wrapType;

  // Only anchor images with 'behind' or 'inFront' wrap types
  // Other wrap types (square, tight, through, topAndBottom) need text wrapping
  // which we don't support yet, so treat them as block-level images
  const shouldAnchor = wrapType === "behind" || wrapType === "inFront";

  const constrained = constrainImageToPage(
    attrs.width || 100,
    attrs.height || 100,
    pageContentHeight,
  );

  const imgBlock: ImageBlock = {
    kind: "image",
    id: nextBlockId(),
    src: attrs.src,
    width: constrained.width,
    height: constrained.height,
    pmStart: startPos,
    pmEnd: startPos + node.nodeSize,
  };
  if (attrs.alt) {
    imgBlock.alt = attrs.alt;
  }
  if (attrs.transform) {
    imgBlock.transform = attrs.transform;
  }
  // eigenpal #424 (opacity render pipeline). `!= null` so PM's null schema
  // default doesn't leak into ImageBlock.opacity (`number | undefined`).
  if (attrs.opacity != null) {
    imgBlock.opacity = attrs.opacity;
  }
  if (shouldAnchor) {
    const anchor: NonNullable<ImageBlock["anchor"]> = {
      isAnchored: true,
      behindDoc: wrapType === "behind",
    };
    if (attrs.distLeft !== undefined) {
      anchor.offsetH = attrs.distLeft;
    }
    if (attrs.distTop !== undefined) {
      anchor.offsetV = attrs.distTop;
    }
    imgBlock.anchor = anchor;
  }
  if (attrs.hlinkHref) {
    imgBlock.hlinkHref = attrs.hlinkHref;
  }
  // eigenpal #424: thread wp:srcRect crop fractions to the floating-image
  // block so renderers can apply clip-path consistently across paths.
  if (attrs.cropTop != null) {
    imgBlock.cropTop = attrs.cropTop;
  }
  if (attrs.cropRight != null) {
    imgBlock.cropRight = attrs.cropRight;
  }
  if (attrs.cropBottom != null) {
    imgBlock.cropBottom = attrs.cropBottom;
  }
  if (attrs.cropLeft != null) {
    imgBlock.cropLeft = attrs.cropLeft;
  }
  return imgBlock;
}

/**
 * Convert a textBox PM node to a TextBoxBlock.
 */
function convertTextBoxNode(
  node: PMNode,
  startPos: number,
  opts: ToFlowBlocksOptions,
): TextBoxBlock {
  const attrs = expectTextBoxAttrs(node);
  const contentBlocks: ParagraphBlock[] = [];

  // Convert child paragraphs inside the text box
  // oxlint-disable-next-line unicorn/no-array-for-each -- ProseMirror Node.forEach
  node.forEach((child, offset) => {
    if (child.type.name === "paragraph") {
      const block = convertParagraph(child, startPos + 1 + offset, opts);
      contentBlocks.push(block);
    }
  });

  const textBox: TextBoxBlock = {
    kind: "textBox",
    id: nextBlockId(),
    width: attrs.width ?? DEFAULT_TEXTBOX_WIDTH,
    margins: {
      top: attrs.marginTop ?? DEFAULT_TEXTBOX_MARGINS.top,
      bottom: attrs.marginBottom ?? DEFAULT_TEXTBOX_MARGINS.bottom,
      left: attrs.marginLeft ?? DEFAULT_TEXTBOX_MARGINS.left,
      right: attrs.marginRight ?? DEFAULT_TEXTBOX_MARGINS.right,
    },
    content: contentBlocks,
    pmStart: startPos,
    pmEnd: startPos + node.nodeSize,
  };
  if (attrs.height !== undefined) {
    textBox.height = attrs.height;
  }
  if (attrs.fillColor !== undefined) {
    textBox.fillColor = attrs.fillColor;
  }
  if (attrs.outlineWidth !== undefined) {
    textBox.outlineWidth = attrs.outlineWidth;
  }
  if (attrs.outlineColor !== undefined) {
    textBox.outlineColor = attrs.outlineColor;
  }
  if (attrs.outlineStyle !== undefined) {
    textBox.outlineStyle = attrs.outlineStyle;
  }
  // Carry anchored-textbox wrap attributes through so the page renderer can
  // build exclusion rects (eigenpal #474).
  if (attrs.displayMode !== undefined) {
    textBox.displayMode = attrs.displayMode;
  }
  if (attrs.cssFloat !== undefined) {
    textBox.cssFloat = attrs.cssFloat;
  }
  if (attrs.wrapType !== undefined) {
    textBox.wrapType = attrs.wrapType;
  }
  if (attrs.wrapText !== undefined) {
    textBox.wrapText = attrs.wrapText;
  }
  if (attrs.distTop !== undefined) {
    textBox.distTop = attrs.distTop;
  }
  if (attrs.distBottom !== undefined) {
    textBox.distBottom = attrs.distBottom;
  }
  if (attrs.distLeft !== undefined) {
    textBox.distLeft = attrs.distLeft;
  }
  if (attrs.distRight !== undefined) {
    textBox.distRight = attrs.distRight;
  }
  return textBox;
}

/**
 * Convert a ProseMirror document to FlowBlock array.
 *
 * Walks the document tree, converting each node to the appropriate block type.
 * Tracks pmStart/pmEnd positions for each block for click-to-position mapping.
 */
export function toFlowBlocks(
  doc: PMNode,
  options: ToFlowBlocksOptions = {},
): FlowBlock[] {
  assertValidProseMirrorDocument(
    doc,
    "Cannot layout invalid ProseMirror document",
  );

  resetBlockIdCounter();

  const opts: ToFlowBlocksOptions = {
    ...options,
    defaultFont: options.defaultFont ?? DEFAULT_FONT,
    defaultSize: options.defaultSize ?? DEFAULT_SIZE,
    listCounters: options.listCounters ?? new Map<number, number[]>(),
    listAbstractCounters:
      options.listAbstractCounters ?? new Map<number, number[]>(),
    listSeenNumIds: options.listSeenNumIds ?? new Set<string>(),
  };

  const blocks: FlowBlock[] = [];
  const offset = 0; // Start at document beginning
  let lastSectionMarginsTwips = {
    top: 1440,
    bottom: 1440,
    left: 1440,
    right: 1440,
  };

  // oxlint-disable-next-line unicorn/no-array-for-each -- ProseMirror Node.forEach
  doc.forEach((node, nodeOffset) => {
    const pos = offset + nodeOffset;

    switch (node.type.name) {
      case "paragraph": {
        const block = convertParagraph(node, pos, opts);
        const pmAttrs = expectParagraphAttrs(node);

        blocks.push(block);

        // Emit section break block if this paragraph ends a section
        const secProps = pmAttrs._sectionProperties as
          | SectionProperties
          | undefined;
        if (secProps || pmAttrs.sectionBreakType) {
          const sectionBreak: SectionBreakBlock = {
            kind: "sectionBreak",
            id: nextBlockId(),
          };
          const breakType = secProps?.sectionStart ?? pmAttrs.sectionBreakType;
          if (breakType) {
            sectionBreak.type = breakType as NonNullable<
              SectionBreakBlock["type"]
            >;
          }

          if (secProps) {
            // Populate page size
            if (secProps.pageWidth || secProps.pageHeight) {
              sectionBreak.pageSize = {
                w: twipsToPixels(secProps.pageWidth ?? 12_240),
                h: twipsToPixels(secProps.pageHeight ?? 15_840),
              };
            }
            // Populate margins
            if (
              secProps.marginTop !== undefined ||
              secProps.marginBottom !== undefined ||
              secProps.marginLeft !== undefined ||
              secProps.marginRight !== undefined
            ) {
              lastSectionMarginsTwips = {
                top: secProps.marginTop ?? lastSectionMarginsTwips.top,
                bottom: secProps.marginBottom ?? lastSectionMarginsTwips.bottom,
                left: secProps.marginLeft ?? lastSectionMarginsTwips.left,
                right: secProps.marginRight ?? lastSectionMarginsTwips.right,
              };
              sectionBreak.margins = {
                top: twipsToPixels(lastSectionMarginsTwips.top),
                bottom: twipsToPixels(lastSectionMarginsTwips.bottom),
                left: twipsToPixels(lastSectionMarginsTwips.left),
                right: twipsToPixels(lastSectionMarginsTwips.right),
              };
            }
            // Populate columns
            const colCount = secProps.columnCount ?? 1;
            if (colCount > 1) {
              const cols: ColumnLayout = {
                count: colCount,
                gap: twipsToPixels(secProps.columnSpace ?? 720),
                equalWidth: secProps.equalWidth ?? true,
              };
              if (secProps.separator !== undefined) {
                cols.separator = secProps.separator;
              }
              sectionBreak.columns = cols;
            }
          }

          blocks.push(sectionBreak);
        }
        break;
      }

      case "table":
        blocks.push(convertTable(node, pos, opts));
        break;

      case "image":
        // Standalone image block (if not inline)
        blocks.push(convertImage(node, pos, opts.pageContentHeight));
        break;

      case "textBox":
        blocks.push(convertTextBoxNode(node, pos, opts));
        break;

      case "horizontalRule":
      case "pageBreak": {
        const pb: PageBreakBlock = {
          kind: "pageBreak",
          id: nextBlockId(),
          pmStart: pos,
          pmEnd: pos + node.nodeSize,
        };
        blocks.push(pb);
        break;
      }
      default:
        break;
    }
  });

  return mergeRunInParagraphs(blocks);
}

/**
 * Merge consecutive paragraph blocks where the first carries
 * `runInWithNext` (`<w:specVanish/>` on the paragraph mark).
 *
 * Word's run-in heading feature renders the next paragraph inline on
 * the same line, so for layout we collapse the pair into one
 * ParagraphBlock with combined runs. The merged block keeps the first
 * paragraph's attrs (heading formatting, list marker, indent) and
 * extends pmEnd to the second paragraph's range so click-to-position
 * resolution still maps both ranges back to body content.
 *
 * Chains: runInWithNext on the merged block is dropped because the
 * second paragraph's mark wasn't `specVanish`. If a chain of
 * specVanish paragraphs needs collapsing (rare in practice), the loop
 * naturally handles it by re-inspecting the merged block's flag (we
 * preserve runInWithNext only when the second paragraph itself has
 * specVanish).
 */
function mergeRunInParagraphs(blocks: FlowBlock[]): FlowBlock[] {
  const out: FlowBlock[] = [];
  for (let i = 0; i < blocks.length; i++) {
    let current = blocks[i];
    if (!current) {
      continue;
    }
    // Chain merge: keep folding consecutive paragraphs while the
    // *current* (possibly already-merged) block carries
    // `runInWithNext` and the next block is also a paragraph. Per
    // ECMA-376 §17.3.1.32 and Word's behaviour, a sequence of
    // `<w:specVanish/>` paragraphs flows inline through the first
    // body paragraph that lacks it (Codex PR #258 review).
    while (
      current.kind === "paragraph" &&
      (current as ParagraphBlock).attrs?.runInWithNext &&
      i + 1 < blocks.length
    ) {
      const next = blocks[i + 1];
      if (!next || next.kind !== "paragraph") {
        break;
      }
      const a = current as ParagraphBlock;
      const b = next as ParagraphBlock;
      const mergedAttrs: ParagraphAttrs = { ...a.attrs };
      // Heading typically has no spaceAfter; the body's spaceAfter
      // governs the merged paragraph's trailing gap.
      if (b.attrs?.spacing?.after !== undefined) {
        mergedAttrs.spacing = {
          ...mergedAttrs.spacing,
          after: b.attrs.spacing.after,
        };
      }
      // Carry forward `runInWithNext` only if the *consumed* second
      // paragraph itself was specVanish — the while condition above
      // then triggers another fold against the paragraph after it.
      if (b.attrs?.runInWithNext) {
        mergedAttrs.runInWithNext = true;
      } else {
        delete mergedAttrs.runInWithNext;
      }
      const merged: ParagraphBlock = {
        ...a,
        runs: [...a.runs, ...b.runs],
        attrs: mergedAttrs,
      };
      const mergedPmEnd = b.pmEnd ?? a.pmEnd;
      if (mergedPmEnd !== undefined) {
        merged.pmEnd = mergedPmEnd;
      }
      current = merged;
      i += 1; // consumed `next`; fold further if the merged block still has the flag
    }
    out.push(current);
  }
  return out;
}
