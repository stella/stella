/**
 * Formatting to CSS Converter
 *
 * Converts OOXML formatting objects (TextFormatting, ParagraphFormatting)
 * to React CSSProperties for rendering.
 *
 * Handles ALL formatting properties:
 * - Font: family, size, weight, style
 * - Text: color, background, decoration (underline, strike, double-strike)
 * - Effects: superscript, subscript, small-caps, all-caps
 * - Spacing: letter-spacing
 * - Paragraph: alignment, line-height, margins, padding, borders, background
 */

import type { CSSProperties } from "react";

import type { ColorValue } from "../types/colors";
import type {
  TextFormatting,
  ParagraphFormatting,
  BorderSpec,
  ShadingProperties,
  Theme,
} from "../types/document";
import {
  resolveColor,
  resolveHighlightToCss,
  resolveShadingColor,
} from "./colorResolver";
import { resolveFontFamily, resolveThemeFont } from "./fontResolver";
import {
  halfPointsToPixels,
  twipsToPixels,
  eighthsToPixels,
  formatPx,
  halfPointsToPoints,
} from "./units";

/**
 * Convert TextFormatting to CSS properties for a run/span
 *
 * @param formatting - Text formatting from OOXML
 * @param theme - Theme for resolving colors and fonts
 * @returns React CSSProperties
 */
export function textToStyle(
  formatting: TextFormatting | undefined | null,
  theme?: Theme | null,
): CSSProperties {
  if (!formatting) {
    return {};
  }

  const style: CSSProperties = {};

  // ============================================================================
  // FONT PROPERTIES
  // ============================================================================

  // Font family
  if (formatting.fontFamily) {
    let fontName: string | null = null;

    // Check for theme font reference first
    if (formatting.fontFamily.asciiTheme && theme?.fontScheme) {
      fontName = resolveThemeFont(
        formatting.fontFamily.asciiTheme,
        theme.fontScheme,
      );
    }

    // Fall back to explicit font names
    if (!fontName) {
      fontName =
        formatting.fontFamily.ascii ||
        formatting.fontFamily.hAnsi ||
        formatting.fontFamily.eastAsia ||
        formatting.fontFamily.cs ||
        null;
    }

    if (fontName) {
      const resolved = resolveFontFamily(fontName);
      style.fontFamily = resolved.cssFallback;
    }
  }

  // Font size (in half-points)
  if (formatting.fontSize !== undefined) {
    // Use pt for font sizes for better cross-browser consistency
    style.fontSize = `${halfPointsToPoints(formatting.fontSize)}pt`;
  }

  // Bold
  if (formatting.bold) {
    style.fontWeight = "bold";
  }

  // Italic
  if (formatting.italic) {
    style.fontStyle = "italic";
  }

  // ============================================================================
  // TEXT COLOR
  // ============================================================================

  if (formatting.color) {
    style.color = resolveColor(formatting.color, theme);
  }

  // ============================================================================
  // BACKGROUND / HIGHLIGHT
  // ============================================================================

  // Highlight (w:highlight)
  if (formatting.highlight && formatting.highlight !== "none") {
    style.backgroundColor = resolveHighlightToCss(formatting.highlight);
  }

  // Character shading (w:shd)
  if (formatting.shading) {
    const shadingBg = resolveShadingFill(formatting.shading, theme);
    if (shadingBg && style.backgroundColor === undefined) {
      style.backgroundColor = shadingBg;
    }
  }

  // ============================================================================
  // TEXT DECORATION
  // ============================================================================

  const decorations: string[] = [];
  const decorationStyles: CSSProperties["textDecorationStyle"][] = [];
  const decorationColors: string[] = [];

  // Underline
  if (formatting.underline && formatting.underline.style !== "none") {
    decorations.push("underline");

    // Map OOXML underline styles to CSS
    const underlineStyle = mapUnderlineStyle(formatting.underline.style);
    if (underlineStyle !== "solid") {
      decorationStyles.push(underlineStyle);
    }

    // Underline color
    if (formatting.underline.color) {
      decorationColors.push(resolveColor(formatting.underline.color, theme));
    }
  }

  // Strikethrough
  if (formatting.strike) {
    decorations.push("line-through");
  }

  // Double strikethrough - CSS doesn't support this directly, use single
  if (formatting.doubleStrike) {
    decorations.push("line-through");
    // Note: Would need custom rendering for true double strike
  }

  if (decorations.length > 0) {
    style.textDecoration = decorations.join(" ");

    if (decorationStyles.length > 0) {
      style.textDecorationStyle = decorationStyles[0];
    }

    if (decorationColors.length > 0) {
      style.textDecorationColor = decorationColors[0];
    }
  }

  // ============================================================================
  // VERTICAL ALIGNMENT (superscript/subscript)
  // ============================================================================

  if (formatting.vertAlign) {
    switch (formatting.vertAlign) {
      case "superscript":
        style.verticalAlign = "super";
        // Also reduce font size
        style.fontSize ??= "0.83em";
        break;
      case "subscript":
        style.verticalAlign = "sub";
        style.fontSize ??= "0.83em";
        break;
      case "baseline":
        break;
      default:
        break;
    }
  }

  // Position (raised/lowered) - alternative to vertAlign
  if (formatting.position !== undefined && formatting.position !== 0) {
    // Position is in half-points, positive = raised, negative = lowered
    const positionPx = halfPointsToPixels(formatting.position);
    style.position = "relative";
    style.top = formatPx(-positionPx); // Negative because CSS top is inverted
  }

  // ============================================================================
  // CAPITALIZATION
  // ============================================================================

  if (formatting.allCaps) {
    style.textTransform = "uppercase";
  } else if (formatting.smallCaps) {
    style.fontVariant = "small-caps";
  }

  // ============================================================================
  // SPACING
  // ============================================================================

  // Letter spacing (character spacing in twips)
  if (formatting.spacing !== undefined && formatting.spacing !== 0) {
    style.letterSpacing = formatPx(twipsToPixels(formatting.spacing));
  }

  // Horizontal scale (w:w) - stretch/compress text
  if (formatting.scale !== undefined && formatting.scale !== 100) {
    // CSS doesn't have direct text scale, use transform
    style.transform = `scaleX(${formatting.scale / 100})`;
    style.display = "inline-block";
  }

  // ============================================================================
  // VISIBILITY
  // ============================================================================

  if (formatting.hidden) {
    style.display = "none";
  }

  // ============================================================================
  // TEXT EFFECTS
  // ============================================================================

  // Emboss
  if (formatting.emboss) {
    style.textShadow =
      "1px 1px 1px rgba(255,255,255,0.5), -1px -1px 1px rgba(0,0,0,0.3)";
  }

  // Imprint/Engrave
  if (formatting.imprint) {
    style.textShadow =
      "-1px -1px 1px rgba(255,255,255,0.5), 1px 1px 1px rgba(0,0,0,0.3)";
  }

  // Outline
  if (formatting.outline) {
    style.WebkitTextStroke = "1px currentColor";
    style.WebkitTextFillColor = "transparent";
  }

  // Shadow
  if (formatting.shadow && !formatting.emboss && !formatting.imprint) {
    style.textShadow = "1px 1px 2px rgba(0,0,0,0.3)";
  }

  // ============================================================================
  // TEXT DIRECTION
  // ============================================================================

  if (formatting.rtl) {
    style.direction = "rtl";
  }

  return style;
}

/**
 * Convert ParagraphFormatting to CSS properties
 *
 * @param formatting - Paragraph formatting from OOXML
 * @param theme - Theme for resolving colors
 * @returns React CSSProperties
 */
export function paragraphToStyle(
  formatting: ParagraphFormatting | undefined | null,
  theme?: Theme | null,
): CSSProperties {
  if (!formatting) {
    return {};
  }

  const style: CSSProperties = {};

  // ============================================================================
  // ALIGNMENT
  // ============================================================================

  if (formatting.alignment) {
    style.textAlign = mapAlignment(formatting.alignment);
  }

  // ============================================================================
  // SPACING (margins)
  // ============================================================================

  // Space before (marginTop)
  if (formatting.spaceBefore !== undefined) {
    style.marginTop = formatPx(twipsToPixels(formatting.spaceBefore));
  }

  // Space after (marginBottom)
  if (formatting.spaceAfter !== undefined) {
    style.marginBottom = formatPx(twipsToPixels(formatting.spaceAfter));
  }

  // ============================================================================
  // LINE SPACING
  // ============================================================================

  if (formatting.lineSpacing !== undefined && formatting.lineSpacing > 0) {
    if (formatting.lineSpacingRule === "exact") {
      // Exact line height in twips
      const exactPx = twipsToPixels(formatting.lineSpacing);
      if (exactPx > 0) {
        style.lineHeight = formatPx(exactPx);
      }
    } else if (formatting.lineSpacingRule === "atLeast") {
      // Minimum line height in twips
      const atLeastPx = twipsToPixels(formatting.lineSpacing);
      if (atLeastPx > 0) {
        style.minHeight = formatPx(atLeastPx);
        style.lineHeight = formatPx(atLeastPx);
      }
    } else {
      // Auto spacing: value is in 240ths of a line (240 = single space)
      // Convert to line-height multiplier
      const lineMultiplier = formatting.lineSpacing / 240;
      // Only set line-height if it's a valid positive value
      if (lineMultiplier > 0) {
        style.lineHeight = lineMultiplier.toString();
      }
    }
  }

  // ============================================================================
  // INDENTATION
  // ============================================================================

  // Left indent
  if (formatting.indentLeft !== undefined) {
    style.marginLeft = formatPx(twipsToPixels(formatting.indentLeft));
  }

  // Right indent
  if (formatting.indentRight !== undefined) {
    style.marginRight = formatPx(twipsToPixels(formatting.indentRight));
  }

  // First line indent / hanging indent
  if (formatting.indentFirstLine !== undefined) {
    // Both hanging indent and regular first-line indent use the same CSS:
    // text-indent handles both (negative for hanging, positive for regular).
    style.textIndent = formatPx(twipsToPixels(formatting.indentFirstLine));
  }

  // ============================================================================
  // BORDERS
  // ============================================================================

  if (formatting.borders) {
    if (formatting.borders.top) {
      Object.assign(style, borderToStyle(formatting.borders.top, "Top", theme));
    }
    if (formatting.borders.bottom) {
      Object.assign(
        style,
        borderToStyle(formatting.borders.bottom, "Bottom", theme),
      );
    }
    if (formatting.borders.left) {
      Object.assign(
        style,
        borderToStyle(formatting.borders.left, "Left", theme),
      );
    }
    if (formatting.borders.right) {
      Object.assign(
        style,
        borderToStyle(formatting.borders.right, "Right", theme),
      );
    }
  }

  // ============================================================================
  // BACKGROUND / SHADING
  // ============================================================================

  if (formatting.shading) {
    const bgColor = resolveShadingFill(formatting.shading, theme);
    if (bgColor) {
      style.backgroundColor = bgColor;
    }
  }

  // ============================================================================
  // TEXT DIRECTION
  // ============================================================================

  if (formatting.bidi) {
    style.direction = "rtl";
  }

  // ============================================================================
  // PAGE BREAK
  // ============================================================================

  // Use the CSS Fragmentation `break-*` properties, not the deprecated
  // `page-break-*` aliases. `page-break-before: always` maps to
  // `break-before: page` (force a page break); `avoid` carries over unchanged.
  if (formatting.pageBreakBefore) {
    style.breakBefore = "page";
  }

  // Keep with next / keep lines together
  if (formatting.keepNext) {
    style.breakAfter = "avoid";
  }

  if (formatting.keepLines) {
    style.breakInside = "avoid";
  }

  return style;
}

/**
 * Convert a BorderSpec to CSS border properties
 *
 * @param border - Border specification
 * @param side - 'Top' | 'Bottom' | 'Left' | 'Right' | '' for all
 * @param theme - Theme for color resolution
 * @returns Partial CSSProperties with border styles
 */
export function borderToStyle(
  border: BorderSpec | undefined | null,
  side: "Top" | "Bottom" | "Left" | "Right" | "" = "",
  theme?: Theme | null,
): CSSProperties {
  if (!border || border.style === "none" || border.style === "nil") {
    return {};
  }

  const style: CSSProperties = {};

  // Width in eighths of a point
  const widthPx =
    border.size !== undefined && border.size !== 0
      ? eighthsToPixels(border.size)
      : 1;

  // Color
  const color = border.color ? resolveColor(border.color, theme) : "#000000";

  // Style
  const cssStyle = mapBorderStyle(border.style);

  // Build the property name dynamically
  const widthKey = `border${side}Width`;
  const styleKey = `border${side}Style`;
  const colorKey = `border${side}Color`;

  Object.assign(style, {
    [colorKey]: color,
    [styleKey]: cssStyle,
    [widthKey]: formatPx(Math.max(1, widthPx)),
  });

  return style;
}

/**
 * Convert ShadingProperties to background color
 *
 * @param shading - Shading properties
 * @param theme - Theme for color resolution
 * @returns CSS color string or empty string
 */
export function resolveShadingFill(
  shading: ShadingProperties | undefined | null,
  theme?: Theme | null,
): string {
  if (!shading) {
    return "";
  }

  // Clear or nil pattern means transparent - check this FIRST
  if (shading.pattern === "clear" || shading.pattern === "nil") {
    return "";
  }

  // Check fill (background color)
  if (shading.fill) {
    // 'auto' fill means transparent
    if (shading.fill.auto) {
      return "";
    }
    // Check for 'auto' RGB value as well
    if (shading.fill.rgb === "auto" || shading.fill.rgb === "FFFFFF") {
      return "";
    }
    return resolveShadingColor(shading.fill, theme);
  }

  // Pattern with solid typically uses the color field
  if (shading.pattern === "solid" && shading.color) {
    return resolveShadingColor(shading.color, theme);
  }

  // For percentage patterns, blend color and fill
  // This is a simplified handling - complex patterns would need more work
  if (shading.pattern && shading.pattern.startsWith("pct") && shading.color) {
    return resolveShadingColor(shading.color, theme);
  }

  return "";
}

/**
 * Map OOXML underline style to CSS text-decoration-style
 */
function mapUnderlineStyle(
  underlineStyle: string,
): "solid" | "double" | "dotted" | "dashed" | "wavy" {
  switch (underlineStyle) {
    case "double":
      return "double";
    case "dotted":
    case "dottedHeavy":
      return "dotted";
    case "dash":
    case "dashedHeavy":
    case "dashLong":
    case "dashLongHeavy":
    case "dotDash":
    case "dashDotHeavy":
    case "dotDotDash":
    case "dashDotDotHeavy":
      return "dashed";
    case "wave":
    case "wavyHeavy":
    case "wavyDouble":
      return "wavy";
    default:
      return "solid";
  }
}

/**
 * Map OOXML paragraph alignment to CSS text-align
 */
function mapAlignment(
  alignment: string,
): "left" | "center" | "right" | "justify" | "start" | "end" {
  switch (alignment) {
    case "center":
      return "center";
    case "right":
      return "right";
    case "both":
    case "distribute":
      return "justify";
    default:
      return "left";
  }
}

/**
 * Map OOXML border style to CSS border-style
 */
function mapBorderStyle(
  borderStyle: string,
):
  | "none"
  | "solid"
  | "double"
  | "dotted"
  | "dashed"
  | "groove"
  | "ridge"
  | "inset"
  | "outset" {
  switch (borderStyle) {
    case "none":
    case "nil":
      return "none";
    case "double":
    case "triple":
      return "double";
    case "dotted":
      return "dotted";
    case "dashed":
    case "dashSmallGap":
      return "dashed";
    case "threeDEmboss":
      return "ridge";
    case "threeDEngrave":
      return "groove";
    case "outset":
      return "outset";
    case "inset":
      return "inset";
    default:
      return "solid";
  }
}

/**
 * Merge multiple CSSProperties objects
 *
 * Later objects override earlier ones for conflicting properties.
 *
 * @param styles - Array of CSSProperties objects
 * @returns Merged CSSProperties
 */
export function mergeStyles(
  ...styles: (CSSProperties | undefined | null)[]
): CSSProperties {
  const result: CSSProperties = {};

  for (const style of styles) {
    if (style) {
      Object.assign(result, style);
    }
  }

  return result;
}

/**
 * Get CSS for a table cell based on formatting
 *
 * @param formatting - Table cell formatting
 * @param theme - Theme for color resolution
 * @returns CSSProperties for the cell
 */
export function tableCellToStyle(
  formatting:
    | {
        verticalAlign?: "top" | "center" | "bottom";
        textDirection?: string;
        shading?: ShadingProperties;
        borders?: {
          top?: BorderSpec;
          bottom?: BorderSpec;
          left?: BorderSpec;
          right?: BorderSpec;
        };
        margins?: {
          top?: { value: number; type: string };
          bottom?: { value: number; type: string };
          left?: { value: number; type: string };
          right?: { value: number; type: string };
        };
      }
    | undefined
    | null,
  theme?: Theme | null,
): CSSProperties {
  if (!formatting) {
    return {};
  }

  const style: CSSProperties = {};

  // Vertical alignment
  if (formatting.verticalAlign) {
    style.verticalAlign = formatting.verticalAlign;
  }

  // Text direction
  // Vertical text would need writing-mode, but that's complex
  if (
    formatting.textDirection &&
    (formatting.textDirection.includes("rl") ||
      formatting.textDirection.includes("Rl"))
  ) {
    style.direction = "rtl";
  }

  // Shading/background
  if (formatting.shading) {
    const bgColor = resolveShadingFill(formatting.shading, theme);
    if (bgColor) {
      style.backgroundColor = bgColor;
    }
  }

  // Borders
  if (formatting.borders) {
    if (formatting.borders.top) {
      Object.assign(style, borderToStyle(formatting.borders.top, "Top", theme));
    }
    if (formatting.borders.bottom) {
      Object.assign(
        style,
        borderToStyle(formatting.borders.bottom, "Bottom", theme),
      );
    }
    if (formatting.borders.left) {
      Object.assign(
        style,
        borderToStyle(formatting.borders.left, "Left", theme),
      );
    }
    if (formatting.borders.right) {
      Object.assign(
        style,
        borderToStyle(formatting.borders.right, "Right", theme),
      );
    }
  }

  // Cell padding (from margins)
  if (formatting.margins) {
    if (
      formatting.margins.top?.value !== undefined &&
      formatting.margins.top.value !== 0
    ) {
      style.paddingTop = formatPx(twipsToPixels(formatting.margins.top.value));
    }
    if (
      formatting.margins.bottom?.value !== undefined &&
      formatting.margins.bottom.value !== 0
    ) {
      style.paddingBottom = formatPx(
        twipsToPixels(formatting.margins.bottom.value),
      );
    }
    if (
      formatting.margins.left?.value !== undefined &&
      formatting.margins.left.value !== 0
    ) {
      style.paddingLeft = formatPx(
        twipsToPixels(formatting.margins.left.value),
      );
    }
    if (
      formatting.margins.right?.value !== undefined &&
      formatting.margins.right.value !== 0
    ) {
      style.paddingRight = formatPx(
        twipsToPixels(formatting.margins.right.value),
      );
    }
  }

  return style;
}

/**
 * Get CSS for page/section container
 *
 * @param sectionProps - Section properties
 * @returns CSSProperties for the page container
 */
export function sectionToStyle(
  sectionProps:
    | {
        pageWidth?: number;
        pageHeight?: number;
        marginTop?: number;
        marginBottom?: number;
        marginLeft?: number;
        marginRight?: number;
        background?: { color?: ColorValue };
      }
    | undefined
    | null,
  theme?: Theme | null,
): CSSProperties {
  if (!sectionProps) {
    return {};
  }

  const style: CSSProperties = {};

  // Page dimensions
  if (sectionProps.pageWidth !== undefined && sectionProps.pageWidth !== 0) {
    style.width = formatPx(twipsToPixels(sectionProps.pageWidth));
  }
  if (sectionProps.pageHeight !== undefined && sectionProps.pageHeight !== 0) {
    style.minHeight = formatPx(twipsToPixels(sectionProps.pageHeight));
  }

  // Margins (as padding on the page container)
  if (sectionProps.marginTop !== undefined && sectionProps.marginTop !== 0) {
    style.paddingTop = formatPx(twipsToPixels(sectionProps.marginTop));
  }
  if (
    sectionProps.marginBottom !== undefined &&
    sectionProps.marginBottom !== 0
  ) {
    style.paddingBottom = formatPx(twipsToPixels(sectionProps.marginBottom));
  }
  if (sectionProps.marginLeft !== undefined && sectionProps.marginLeft !== 0) {
    style.paddingLeft = formatPx(twipsToPixels(sectionProps.marginLeft));
  }
  if (
    sectionProps.marginRight !== undefined &&
    sectionProps.marginRight !== 0
  ) {
    style.paddingRight = formatPx(twipsToPixels(sectionProps.marginRight));
  }

  // Background color
  if (sectionProps.background?.color) {
    const bgColor = resolveColor(sectionProps.background.color, theme);
    if (bgColor) {
      style.backgroundColor = bgColor;
    }
  }

  return style;
}
