/**
 * ProseMirror to FlowBlock Converter
 *
 * Converts a ProseMirror document into FlowBlock[] for the layout engine.
 * Tracks pmStart/pmEnd positions for click-to-position mapping.
 */

import type { Node as PMNode, Mark } from "prosemirror-model";

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
  LineBreakRun,
  FieldRun,
  RunFormatting,
  ParagraphAttrs,
  TabStop,
} from "../layout-engine/types";
import {
  DEFAULT_TEXTBOX_MARGINS,
  DEFAULT_TEXTBOX_WIDTH,
} from "../layout-engine/types";
import type {
  TextColorAttrs,
  UnderlineAttrs,
  FontSizeAttrs,
  FontFamilyAttrs,
} from "../prosemirror/schema/marks";
import type { ParagraphAttrs as PMParagraphAttrs } from "../prosemirror/schema/nodes";
import type {
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
};

const DEFAULT_FONT = "Calibri";
const DEFAULT_TABLE_CELL_MARGIN_TWIPS = {
  top: 0,
  right: 108,
  bottom: 0,
  left: 108,
} as const;
type TablePaddingSide = keyof typeof DEFAULT_TABLE_CELL_MARGIN_TWIPS;

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
  let remaining = value;
  let output = "";
  while (remaining > 0) {
    const remainder = (remaining - 1) % 26;
    output = String.fromCodePoint(65 + remainder) + output;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return upper ? output : output.toLowerCase();
}

function formatCounter(
  value: number,
  format: NumberFormat | undefined,
): string {
  if (value <= 0) {
    return "";
  }
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
  return template.replace(/%(\d)([.):\]])?/g, (_match, digit, punct = "") => {
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
  if (numId === null || numId === undefined || numId === 0) {
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
    return pmAttrs.listMarker || "•";
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
        const attrs = mark.attrs as UnderlineAttrs;
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
        const attrs = mark.attrs as TextColorAttrs;
        if (attrs.themeColor || attrs.rgb) {
          const colorArg: Parameters<typeof resolveColor>[0] = {};
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
          formatting.color = resolveColor(colorArg, theme);
        }
        break;
      }

      case "highlight":
        formatting.highlight = resolveHighlightToCss(
          mark.attrs["color"] as string,
        );
        break;

      case "fontSize": {
        const attrs = mark.attrs as FontSizeAttrs;
        // Convert half-points to points
        formatting.fontSize = attrs.size / 2;
        break;
      }

      case "fontFamily": {
        const attrs = mark.attrs as FontFamilyAttrs;
        const font = attrs.ascii || attrs.hAnsi;
        if (font) {
          formatting.fontFamily = font;
        }
        break;
      }

      case "characterSpacing": {
        const attrs = mark.attrs as {
          spacing: number | null;
          position: number | null;
          scale: number | null;
          kerning: number | null;
        };
        if (attrs.spacing != null && attrs.spacing !== 0) {
          formatting.letterSpacing = twipsToPixels(attrs.spacing);
        }
        if (attrs.position != null && attrs.position !== 0) {
          formatting.positionPx = halfPointsToPixels(attrs.position);
        }
        if (attrs.scale != null && attrs.scale !== 100) {
          formatting.horizontalScale = attrs.scale;
        }
        if (attrs.kerning != null && attrs.kerning > 0) {
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

      case "textShadow":
        formatting.textShadow = true;
        break;

      case "textOutline":
        formatting.textOutline = true;
        break;

      case "runFormattingOverride":
        applyRunFormattingOverrides(formatting, mark);
        break;

      case "emphasisMark": {
        const type = mark.attrs["type"] as string | undefined;
        formatting.emphasisMark =
          type === "dot" ||
          type === "comma" ||
          type === "circle" ||
          type === "underDot"
            ? type
            : "dot";
        break;
      }

      case "superscript":
        formatting.superscript = true;
        break;

      case "subscript":
        formatting.subscript = true;
        break;

      case "hyperlink": {
        const attrs = mark.attrs as { href: string; tooltip?: string };
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
        const attrs = mark.attrs as { id: string | number; noteType?: string };
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
        const commentId = mark.attrs["commentId"] as number;
        if (commentId) {
          if (!formatting.commentIds) {
            formatting.commentIds = [];
          }
          formatting.commentIds.push(commentId);
        }
        break;
      }

      case "insertion":
        formatting.isInsertion = true;
        formatting.changeAuthor = mark.attrs["author"] as string;
        formatting.changeDate = mark.attrs["date"] as string;
        formatting.changeRevisionId = mark.attrs["revisionId"] as number;
        break;

      case "deletion":
        formatting.isDeletion = true;
        formatting.changeAuthor = mark.attrs["author"] as string;
        formatting.changeDate = mark.attrs["date"] as string;
        formatting.changeRevisionId = mark.attrs["revisionId"] as number;
        break;
      default:
        break;
    }
  }

  return formatting;
}

function applyRunFormattingOverrides(
  formatting: RunFormatting,
  mark: Mark,
): void {
  if (mark.attrs["bold"] === false) {
    formatting.bold = false;
  }
  if (mark.attrs["italic"] === false) {
    formatting.italic = false;
  }
  if (mark.attrs["underline"] === "none") {
    formatting.underline = false;
  }
  if (mark.attrs["strike"] === false) {
    formatting.strike = false;
  }
  if (mark.attrs["allCaps"] === false) {
    formatting.allCaps = false;
  }
  if (mark.attrs["smallCaps"] === false) {
    formatting.smallCaps = false;
  }
  if (mark.attrs["emboss"] === false) {
    formatting.emboss = false;
  }
  if (mark.attrs["imprint"] === false) {
    formatting.imprint = false;
  }
  if (mark.attrs["shadow"] === false) {
    formatting.textShadow = false;
  }
  if (mark.attrs["outline"] === false) {
    formatting.textOutline = false;
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
    result.underline = {};
    if (defaultTextFormatting.underline.style) {
      result.underline.style = defaultTextFormatting.underline.style;
    }
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
  if (defaultTextFormatting.color) {
    result.color = resolveColor(defaultTextFormatting.color, theme);
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
  attrs: Record<string, unknown>,
  constrained: { width: number; height: number },
  pmStart: number,
  pmEnd: number,
): ImageRun {
  const run: ImageRun = {
    kind: "image",
    src: attrs["src"] as string,
    width: constrained.width,
    height: constrained.height,
    pmStart,
    pmEnd,
  };
  if (attrs["alt"] !== undefined && attrs["alt"] !== null) {
    run.alt = attrs["alt"] as string;
  }
  if (attrs["transform"] !== undefined && attrs["transform"] !== null) {
    run.transform = attrs["transform"] as string;
  }
  if (attrs["wrapType"] !== undefined && attrs["wrapType"] !== null) {
    run.wrapType = attrs["wrapType"] as string;
  }
  if (attrs["displayMode"] !== undefined && attrs["displayMode"] !== null) {
    run.displayMode = attrs["displayMode"] as "inline" | "block" | "float";
  }
  if (attrs["cssFloat"] !== undefined && attrs["cssFloat"] !== null) {
    run.cssFloat = attrs["cssFloat"] as "left" | "right" | "none";
  }
  if (attrs["distTop"] !== undefined && attrs["distTop"] !== null) {
    run.distTop = attrs["distTop"] as number;
  }
  if (attrs["distBottom"] !== undefined && attrs["distBottom"] !== null) {
    run.distBottom = attrs["distBottom"] as number;
  }
  if (attrs["distLeft"] !== undefined && attrs["distLeft"] !== null) {
    run.distLeft = attrs["distLeft"] as number;
  }
  if (attrs["distRight"] !== undefined && attrs["distRight"] !== null) {
    run.distRight = attrs["distRight"] as number;
  }
  if (attrs["position"] !== undefined && attrs["position"] !== null) {
    run.position = attrs["position"] as NonNullable<ImageRun["position"]>;
  }
  return run;
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
  const paraDefaults = paragraphRunDefaults(
    node.attrs as PMParagraphAttrs,
    theme,
  );

  // oxlint-disable-next-line unicorn/no-array-for-each -- ProseMirror Node.forEach
  node.forEach((child, childOffset) => {
    const childPos = offset + childOffset;

    if (child.isText && child.text) {
      // Text node - create text run
      const formatting = extractRunFormatting(child.marks, theme);
      const run: TextRun = {
        kind: "text",
        text: child.text,
        ...paraDefaults,
        ...formatting,
        pmStart: childPos,
        pmEnd: childPos + child.nodeSize,
      };
      runs.push(run);
    } else if (child.type.name === "hardBreak") {
      // Line break
      const run: LineBreakRun = {
        kind: "lineBreak",
        pmStart: childPos,
        pmEnd: childPos + child.nodeSize,
      };
      runs.push(run);
    } else if (child.type.name === "tab") {
      // Tab character
      const formatting = extractRunFormatting(child.marks, theme);
      const run: TabRun = {
        kind: "tab",
        ...paraDefaults,
        ...formatting,
        pmStart: childPos,
        pmEnd: childPos + child.nodeSize,
      };
      runs.push(run);
    } else if (child.type.name === "image") {
      // Image within paragraph
      const attrs = child.attrs;
      const constrained = constrainImageToPage(
        (attrs["width"] as number) || 100,
        (attrs["height"] as number) || 100,
        _options.pageContentHeight,
      );
      const run = buildImageRun(
        attrs,
        constrained,
        childPos,
        childPos + child.nodeSize,
      );
      runs.push(run);
    } else if (child.type.name === "field") {
      // Field node — convert to FieldRun for render-time substitution
      const ft = child.attrs["fieldType"] as string;
      const mappedType: FieldRun["fieldType"] =
        ft === "PAGE"
          ? "PAGE"
          : ft === "NUMPAGES"
            ? "NUMPAGES"
            : ft === "DATE"
              ? "DATE"
              : ft === "TIME"
                ? "TIME"
                : "OTHER";
      const run: FieldRun = {
        kind: "field",
        fieldType: mappedType,
        fallback: (child.attrs["displayText"] as string) || "",
        pmStart: childPos,
        pmEnd: childPos + child.nodeSize,
      };
      runs.push(run);
    } else if (child.type.name === "math") {
      // Math node — render as plain text fallback in layout
      const text = (child.attrs["plainText"] as string) || "[equation]";
      const run: TextRun = {
        kind: "text",
        text,
        italic: true,
        fontFamily: "Cambria Math",
        pmStart: childPos,
        pmEnd: childPos + child.nodeSize,
      };
      runs.push(run);
    } else if (child.type.name === "sdt") {
      // SDT (Structured Document Tag / content control) — inline wrapper node.
      // Descend into its children to extract the actual text runs.
      const sdtInnerOffset = childPos + 1; // +1 for opening tag
      // oxlint-disable-next-line unicorn/no-array-for-each -- ProseMirror Node.forEach
      child.forEach((sdtChild, sdtChildOffset) => {
        const sdtChildPos = sdtInnerOffset + sdtChildOffset;
        if (sdtChild.isText && sdtChild.text) {
          const formatting = extractRunFormatting(sdtChild.marks, theme);
          const run: TextRun = {
            kind: "text",
            text: sdtChild.text,
            ...paraDefaults,
            ...formatting,
            pmStart: sdtChildPos,
            pmEnd: sdtChildPos + sdtChild.nodeSize,
          };
          runs.push(run);
        } else if (sdtChild.type.name === "hardBreak") {
          const run: LineBreakRun = {
            kind: "lineBreak",
            pmStart: sdtChildPos,
            pmEnd: sdtChildPos + sdtChild.nodeSize,
          };
          runs.push(run);
        } else if (sdtChild.type.name === "tab") {
          const formatting = extractRunFormatting(sdtChild.marks, theme);
          const run: TabRun = {
            kind: "tab",
            ...paraDefaults,
            ...formatting,
            pmStart: sdtChildPos,
            pmEnd: sdtChildPos + sdtChild.nodeSize,
          };
          runs.push(run);
        } else if (sdtChild.type.name === "image") {
          const attrs = sdtChild.attrs;
          const sdtConstrained = constrainImageToPage(
            (attrs["width"] as number) || 100,
            (attrs["height"] as number) || 100,
            _options.pageContentHeight,
          );
          const run = buildImageRun(
            attrs,
            sdtConstrained,
            sdtChildPos,
            sdtChildPos + sdtChild.nodeSize,
          );
          runs.push(run);
        }
      });
    }
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

  // Shading (background color)
  if (pmAttrs.shading?.fill?.rgb) {
    attrs.shading = `#${pmAttrs.shading.fill.rgb}`;
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
    attrs.listMarker = pmAttrs.listMarker;
  }
  if (pmAttrs.listIsBullet !== undefined && pmAttrs.listIsBullet !== null) {
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
  const pmAttrs = node.attrs as PMParagraphAttrs;
  const runs = paragraphToRuns(node, startPos, options);
  const attrs = convertParagraphAttrs(
    pmAttrs,
    options.theme,
    options.listCounters,
    options.listAbstractCounters,
    options.listSeenNumIds,
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
  if (
    !border ||
    !border.style ||
    border.style === "none" ||
    border.style === "nil"
  ) {
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
  attrs: Record<string, unknown>,
  theme?: Theme | null,
): CellBorders | undefined {
  const borders = attrs["borders"] as Record<
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
  > | null;

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

  const attrs = node.attrs;

  // Convert cell margins (twips) to pixel padding
  // OOXML TableNormal defaults: top=0, bottom=0, left=108 twips (~7px), right=108 twips (~7px)
  const margins = attrs["margins"] as
    | { top?: number; bottom?: number; left?: number; right?: number }
    | undefined;
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
    colSpan: attrs["colspan"] as number,
    rowSpan: attrs["rowspan"] as number,
    padding,
  };
  if (attrs["width"]) {
    cell.width = twipsToPixels(attrs["width"] as number);
  }
  if (attrs["verticalAlign"]) {
    cell.verticalAlign = attrs["verticalAlign"] as "top" | "center" | "bottom";
  }
  if (attrs["backgroundColor"]) {
    cell.background = `#${attrs["backgroundColor"]}`;
  }
  const cellBorders = extractCellBorders(
    attrs as Record<string, unknown>,
    options.theme,
  );
  if (cellBorders) {
    cell.borders = cellBorders;
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

  const attrs = node.attrs;
  const row: TableRow = {
    id: nextBlockId(),
    cells,
  };
  if (attrs["height"]) {
    row.height = twipsToPixels(attrs["height"] as number);
  }
  if (attrs["heightRule"]) {
    row.heightRule = attrs["heightRule"] as "auto" | "atLeast" | "exact";
  }
  if (attrs["isHeader"]) {
    row.isHeader = attrs["isHeader"] as boolean;
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
  const tableCellMargins = node.attrs["cellMargins"] as
    | { top?: number; bottom?: number; left?: number; right?: number }
    | undefined;

  // oxlint-disable-next-line unicorn/no-array-for-each -- ProseMirror Node.forEach
  node.forEach((child) => {
    if (child.type.name === "tableRow") {
      rows.push(convertTableRow(child, offset, options, tableCellMargins));
    }
    offset += child.nodeSize;
  });

  // Extract columnWidths from node attributes and convert from twips to pixels
  const columnWidthsTwips = node.attrs["columnWidths"] as number[] | undefined;
  let columnWidths = columnWidthsTwips?.map(twipsToPixels);

  const width = node.attrs["width"] as number | undefined;
  const widthType = node.attrs["widthType"] as string | undefined;

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
  const justification = node.attrs["justification"] as
    | "left"
    | "center"
    | "right"
    | undefined;

  // Extract table indent from _originalFormatting (w:tblInd)
  const originalFormatting = node.attrs["_originalFormatting"] as
    | { indent?: { value: number; type: string } }
    | undefined;
  const indentPx =
    originalFormatting?.indent?.value &&
    originalFormatting.indent.type === "dxa"
      ? twipsToPixels(originalFormatting.indent.value)
      : undefined;

  const floating = node.attrs["floating"] as
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

  let floatingPx:
    | import("../layout-engine/types").FloatingTablePosition
    | undefined;
  if (floating) {
    const fp: import("../layout-engine/types").FloatingTablePosition = {};
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
  const attrs = node.attrs;
  const wrapType = attrs["wrapType"] as string | undefined;

  // Only anchor images with 'behind' or 'inFront' wrap types
  // Other wrap types (square, tight, through, topAndBottom) need text wrapping
  // which we don't support yet, so treat them as block-level images
  const shouldAnchor = wrapType === "behind" || wrapType === "inFront";

  const constrained = constrainImageToPage(
    (attrs["width"] as number) || 100,
    (attrs["height"] as number) || 100,
    pageContentHeight,
  );

  const imgBlock: ImageBlock = {
    kind: "image",
    id: nextBlockId(),
    src: attrs["src"] as string,
    width: constrained.width,
    height: constrained.height,
    pmStart: startPos,
    pmEnd: startPos + node.nodeSize,
  };
  if (attrs["alt"]) {
    imgBlock.alt = attrs["alt"] as string;
  }
  if (attrs["transform"]) {
    imgBlock.transform = attrs["transform"] as string;
  }
  if (shouldAnchor) {
    const anchor: NonNullable<ImageBlock["anchor"]> = {
      isAnchored: true,
      behindDoc: wrapType === "behind",
    };
    if (attrs["distLeft"] !== undefined && attrs["distLeft"] !== null) {
      anchor.offsetH = attrs["distLeft"] as number;
    }
    if (attrs["distTop"] !== undefined && attrs["distTop"] !== null) {
      anchor.offsetV = attrs["distTop"] as number;
    }
    imgBlock.anchor = anchor;
  }
  if (attrs["hlinkHref"]) {
    imgBlock.hlinkHref = attrs["hlinkHref"] as string;
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
  const attrs = node.attrs;
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
    width: (attrs["width"] as number) ?? DEFAULT_TEXTBOX_WIDTH,
    margins: {
      top: (attrs["marginTop"] as number) ?? DEFAULT_TEXTBOX_MARGINS.top,
      bottom:
        (attrs["marginBottom"] as number) ?? DEFAULT_TEXTBOX_MARGINS.bottom,
      left: (attrs["marginLeft"] as number) ?? DEFAULT_TEXTBOX_MARGINS.left,
      right: (attrs["marginRight"] as number) ?? DEFAULT_TEXTBOX_MARGINS.right,
    },
    content: contentBlocks,
    pmStart: startPos,
    pmEnd: startPos + node.nodeSize,
  };
  if (attrs["height"] != null) {
    textBox.height = attrs["height"] as number;
  }
  if (attrs["fillColor"] != null) {
    textBox.fillColor = attrs["fillColor"] as string;
  }
  if (attrs["outlineWidth"] != null) {
    textBox.outlineWidth = attrs["outlineWidth"] as number;
  }
  if (attrs["outlineColor"] != null) {
    textBox.outlineColor = attrs["outlineColor"] as string;
  }
  if (attrs["outlineStyle"] != null) {
    textBox.outlineStyle = attrs["outlineStyle"] as string;
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
        const pmAttrs = node.attrs as PMParagraphAttrs;

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

  return blocks;
}
