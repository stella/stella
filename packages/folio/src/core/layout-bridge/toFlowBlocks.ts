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
import type { Theme, SectionProperties } from "../types/document";
import { resolveColor, resolveHighlightToCss } from "../utils/colorResolver";
import { pointsToPixels } from "../utils/units";

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
};

const DEFAULT_FONT = "Calibri";

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

/**
 * Replace %1..%9 placeholders in a format string with counter values.
 */
function substituteMarkerPlaceholders(
  template: string,
  counters: number[],
): string {
  let result = template;
  for (let i = 1; i <= 9; i++) {
    const ph = `%${i}`;
    if (result.includes(ph)) {
      // Use || 1 (not ?? 1) so that 0 is treated as "not yet counted"
      result = result.replaceAll(ph, String(counters[i - 1] || 1));
    }
  }
  return result;
}

/**
 * Resolve the display marker for a numbered or bullet list item.
 */
function resolveListMarker(
  pmAttrs: { listIsBullet?: boolean; listMarker?: string },
  counters: number[],
  level: number,
): string {
  if (pmAttrs.listIsBullet) {
    return pmAttrs.listMarker || "•";
  }
  if (pmAttrs.listMarker && pmAttrs.listMarker.includes("%")) {
    return substituteMarkerPlaceholders(pmAttrs.listMarker, counters);
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

  // oxlint-disable-next-line unicorn/no-array-for-each -- ProseMirror Node.forEach
  node.forEach((child, childOffset) => {
    const childPos = offset + childOffset;

    if (child.isText && child.text) {
      // Text node - create text run
      const formatting = extractRunFormatting(child.marks, theme);
      const run: TextRun = {
        kind: "text",
        text: child.text,
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
  if (
    pmAttrs.spaceBefore !== undefined ||
    pmAttrs.spaceAfter !== undefined ||
    pmAttrs.lineSpacing !== undefined
  ) {
    attrs.spacing = {};
    if (pmAttrs.spaceBefore !== undefined) {
      attrs.spacing.before = twipsToPixels(pmAttrs.spaceBefore);
    }
    if (pmAttrs.spaceAfter !== undefined) {
      attrs.spacing.after = twipsToPixels(pmAttrs.spaceAfter);
    }
    if (pmAttrs.lineSpacing !== undefined) {
      // Line spacing in twips - convert to multiplier or exact
      if (
        pmAttrs.lineSpacingRule === "exact" ||
        pmAttrs.lineSpacingRule === "atLeast"
      ) {
        attrs.spacing.line = twipsToPixels(pmAttrs.lineSpacing);
        attrs.spacing.lineUnit = "px";
        attrs.spacing.lineRule = pmAttrs.lineSpacingRule;
      } else {
        // Auto - line spacing is in 240ths of a line
        attrs.spacing.line = pmAttrs.lineSpacing / 240;
        attrs.spacing.lineUnit = "multiplier";
        attrs.spacing.lineRule = "auto";
      }
    }
  }

  // Indentation - handle list item fallback calculation
  // For list items without explicit indentation, calculate based on level
  let indentLeft = pmAttrs.indentLeft;
  let indentFirstLine = pmAttrs.indentFirstLine;
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
    pmAttrs.indentRight !== undefined ||
    indentFirstLine !== undefined
  ) {
    attrs.indent = {};
    if (indentLeft !== undefined) {
      attrs.indent.left = twipsToPixels(indentLeft);
    }
    if (pmAttrs.indentRight !== undefined) {
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
  if (pmAttrs.listMarker) {
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
  const attrs = convertParagraphAttrs(pmAttrs, options.theme);

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
  listCounters?: Map<number, number[]>,
): TableCell {
  const blocks: FlowBlock[] = [];
  let offset = startPos + 1; // +1 for opening tag

  // oxlint-disable-next-line unicorn/no-array-for-each -- ProseMirror Node.forEach
  node.forEach((child) => {
    if (child.type.name === "paragraph") {
      const block = convertParagraph(child, offset, options);
      // Resolve list markers inside table cells using shared counters
      if (listCounters) {
        const pmAttrs = child.attrs as PMParagraphAttrs;
        if (pmAttrs.numPr) {
          const numId = pmAttrs.numPr.numId;
          if (numId !== null && numId !== undefined && numId !== 0) {
            const level = pmAttrs.numPr.ilvl ?? 0;
            const counters =
              listCounters.get(numId) ??
              (Array.from({ length: 9 }, () => 0) as number[]);
            counters[level] = (counters[level] ?? 0) + 1;
            for (let i = level + 1; i < counters.length; i += 1) {
              counters[i] = 0;
            }
            listCounters.set(numId, counters);
            const marker = resolveListMarker(pmAttrs, counters, level);
            block.attrs = { ...block.attrs, listMarker: marker };
          }
        } else if (pmAttrs.listMarker?.includes("%") && !pmAttrs.listIsBullet) {
          const lastCounters =
            listCounters.size > 0
              ? Array.from(listCounters.values()).at(-1)
              : undefined;
          if (lastCounters) {
            const marker = substituteMarkerPlaceholders(
              pmAttrs.listMarker,
              lastCounters as number[],
            );
            block.attrs = { ...block.attrs, listMarker: marker };
          }
        }
      }
      blocks.push(block);
    } else if (child.type.name === "table") {
      blocks.push(convertTable(child, offset, options, listCounters));
    }
    offset += child.nodeSize;
  });

  const attrs = node.attrs;

  // Convert cell margins (twips) to pixel padding
  // OOXML TableNormal defaults: top=0, bottom=0, left=108 twips (~7px), right=108 twips (~7px)
  const margins = attrs["margins"] as
    | { top?: number; bottom?: number; left?: number; right?: number }
    | undefined;
  const padding = {
    top: margins?.top !== undefined ? twipsToPixels(margins.top) : 0,
    right: margins?.right !== undefined ? twipsToPixels(margins.right) : 7,
    bottom: margins?.bottom !== undefined ? twipsToPixels(margins.bottom) : 0,
    left: margins?.left !== undefined ? twipsToPixels(margins.left) : 7,
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
  listCounters?: Map<number, number[]>,
): TableRow {
  const cells: TableCell[] = [];
  let offset = startPos + 1; // +1 for opening tag

  // oxlint-disable-next-line unicorn/no-array-for-each -- ProseMirror Node.forEach
  node.forEach((child) => {
    if (child.type.name === "tableCell" || child.type.name === "tableHeader") {
      cells.push(convertTableCell(child, offset, options, listCounters));
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
  listCounters?: Map<number, number[]>,
): TableBlock {
  const rows: TableRow[] = [];
  let offset = startPos + 1; // +1 for opening tag

  // oxlint-disable-next-line unicorn/no-array-for-each -- ProseMirror Node.forEach
  node.forEach((child) => {
    if (child.type.name === "tableRow") {
      rows.push(convertTableRow(child, offset, options, listCounters));
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
  const opts: ToFlowBlocksOptions = {
    ...options,
    defaultFont: options.defaultFont ?? DEFAULT_FONT,
    defaultSize: options.defaultSize ?? DEFAULT_SIZE,
  };

  const blocks: FlowBlock[] = [];
  const offset = 0; // Start at document beginning
  const listCounters = new Map<number, number[]>();

  // oxlint-disable-next-line unicorn/no-array-for-each -- ProseMirror Node.forEach
  doc.forEach((node, nodeOffset) => {
    const pos = offset + nodeOffset;

    switch (node.type.name) {
      case "paragraph": {
        const block = convertParagraph(node, pos, opts);
        const pmAttrs = node.attrs as PMParagraphAttrs;

        if (pmAttrs.numPr) {
          const numId = pmAttrs.numPr.numId;
          // numId === 0 means "no numbering" per OOXML spec (ECMA-376)
          if (numId !== null && numId !== undefined && numId !== 0) {
            const level = pmAttrs.numPr.ilvl ?? 0;
            const counters =
              listCounters.get(numId) ??
              (Array.from({ length: 9 }, () => 0) as number[]);

            counters[level] = (counters[level] ?? 0) + 1;
            for (let i = level + 1; i < counters.length; i += 1) {
              counters[i] = 0;
            }

            listCounters.set(numId, counters);

            // Compute the rendered marker text.
            // Bullets keep their character as-is. For numbered lists,
            // if the DOCX lvlText contains %N placeholders (e.g., "%1.%2"),
            // substitute them with the actual counter values.
            const marker = resolveListMarker(pmAttrs, counters, level);
            block.attrs = { ...block.attrs, listMarker: marker };
          }
        } else if (
          pmAttrs.listMarker &&
          pmAttrs.listMarker.includes("%") &&
          !pmAttrs.listIsBullet
        ) {
          // Paragraph has a raw format-string marker (e.g., "%1.%2") from
          // style-inherited numbering but no numPr to drive counters.
          // Substitute placeholders with the most-recently-used counters
          // so the marker isn't rendered literally.
          const lastCounters =
            listCounters.size > 0
              ? Array.from(listCounters.values()).at(-1)
              : undefined;
          if (lastCounters) {
            const marker = substituteMarkerPlaceholders(
              pmAttrs.listMarker,
              lastCounters as number[],
            );
            block.attrs = { ...block.attrs, listMarker: marker };
          }
        }

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
              secProps.marginLeft !== undefined
            ) {
              sectionBreak.margins = {
                top: twipsToPixels(secProps.marginTop ?? 1440),
                bottom: twipsToPixels(secProps.marginBottom ?? 1440),
                left: twipsToPixels(secProps.marginLeft ?? 1440),
                right: twipsToPixels(secProps.marginRight ?? 1440),
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
        blocks.push(convertTable(node, pos, opts, listCounters));
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
