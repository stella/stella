/**
 * Shared DrawingML Parsing Utilities
 *
 * Common functions used by imageParser and textBoxParser
 * for parsing DrawingML elements (positions, wrapping, colors, fills, outlines).
 */

import type {
  ImagePosition,
  ImageWrap,
  ShapeFill,
  ShapeOutline,
  ColorValue,
} from "../types/document";
import {
  ImageHorizontalAlignmentSchema,
  ImageHorizontalRelativeToSchema,
  ImageVerticalAlignmentSchema,
  ImageVerticalRelativeToSchema,
  ImageWrapTextSchema,
  ShapeOutlineStyleSchema,
  narrowEnum,
} from "./parserEnums";
import {
  getChildElements,
  getAttribute,
  getTextContent,
  parseNumericAttribute,
  findByFullName,
} from "./xmlParser";
import type { XmlElement } from "./xmlParser";

// ============================================================================
// COLOR PARSING
// ============================================================================

/**
 * Map OOXML scheme names to standard theme color slots.
 * Used when parsing a:schemeClr elements in DrawingML.
 */
const SCHEME_TO_THEME_COLOR: Record<string, ColorValue["themeColor"]> = {
  accent1: "accent1",
  accent2: "accent2",
  accent3: "accent3",
  accent4: "accent4",
  accent5: "accent5",
  accent6: "accent6",
  dk1: "dk1",
  lt1: "lt1",
  dk2: "dk2",
  lt2: "lt2",
  tx1: "text1",
  tx2: "text2",
  bg1: "background1",
  bg2: "background2",
  hlink: "hlink",
  folHlink: "folHlink",
};

/**
 * sRGB hex per OOXML (ST_HexColorRGB): exactly six hex digits, case-insensitive.
 * Anything else is rejected so untrusted DOCX input cannot smuggle markup through
 * downstream renderers that interpolate the value into HTML/SVG.
 */
const HEX_COLOR_RE = /^[0-9A-Fa-f]{6}$/u;

function isHexColor(val: string | undefined | null): val is string {
  return typeof val === "string" && HEX_COLOR_RE.test(val);
}

/**
 * Common preset color names to RGB hex values.
 */
const PRESET_COLORS: Record<string, string> = {
  black: "000000",
  white: "FFFFFF",
  red: "FF0000",
  green: "00FF00",
  blue: "0000FF",
  yellow: "FFFF00",
  cyan: "00FFFF",
  magenta: "FF00FF",
};

/**
 * Apply color modifiers (shade, tint) from child elements of a color element.
 * Converts DrawingML 100000ths-scale values to hex (0-FF) for OOXML compatibility.
 */
function applyColorModifiers(
  color: ColorValue,
  element: XmlElement,
): ColorValue {
  const children = getChildElements(element);

  const shade = children.find((el) => el.name === "a:shade");
  if (shade) {
    const val = getAttribute(shade, null, "val");
    if (val) {
      color.themeShade = Math.round((Number.parseInt(val, 10) / 100_000) * 255)
        .toString(16)
        .padStart(2, "0")
        .toUpperCase();
    }
  }

  const tint = children.find((el) => el.name === "a:tint");
  if (tint) {
    const val = getAttribute(tint, null, "val");
    if (val) {
      color.themeTint = Math.round((Number.parseInt(val, 10) / 100_000) * 255)
        .toString(16)
        .padStart(2, "0")
        .toUpperCase();
    }
  }

  return color;
}

/**
 * Parse a color value from a DrawingML element.
 * Handles: a:srgbClr, a:schemeClr, a:sysClr, a:prstClr
 * Applies shade/tint modifiers when present.
 */
export function parseColorElement(
  element: XmlElement | null,
): ColorValue | undefined {
  if (!element) {
    return undefined;
  }

  const children = getChildElements(element);

  // sRGB color: a:srgbClr[@val] — must be 6 hex digits per OOXML
  const srgbClr = children.find((el) => el.name === "a:srgbClr");
  if (srgbClr) {
    const val = getAttribute(srgbClr, null, "val");
    if (isHexColor(val)) {
      return applyColorModifiers({ rgb: val.toUpperCase() }, srgbClr);
    }
  }

  // Scheme color (theme): a:schemeClr[@val]
  const schemeClr = children.find((el) => el.name === "a:schemeClr");
  if (schemeClr) {
    const val = getAttribute(schemeClr, null, "val");
    if (val) {
      const color: ColorValue = {
        themeColor: SCHEME_TO_THEME_COLOR[val] ?? "dk1",
      };
      return applyColorModifiers(color, schemeClr);
    }
  }

  // System color: a:sysClr[@lastClr] — fall back to black if missing/malformed
  const sysClr = children.find((el) => el.name === "a:sysClr");
  if (sysClr) {
    const lastClr = getAttribute(sysClr, null, "lastClr");
    return { rgb: isHexColor(lastClr) ? lastClr.toUpperCase() : "000000" };
  }

  // Preset color: a:prstClr[@val]
  const prstClr = children.find((el) => el.name === "a:prstClr");
  if (prstClr) {
    const val = getAttribute(prstClr, null, "val");
    if (val && PRESET_COLORS[val]) {
      return { rgb: PRESET_COLORS[val] };
    }
  }

  return undefined;
}

// ============================================================================
// FILL & OUTLINE PARSING
// ============================================================================

/**
 * Parse fill from shape properties (a:solidFill, a:noFill, a:gradFill).
 */
export function parseFill(spPr: XmlElement | null): ShapeFill | undefined {
  if (!spPr) {
    return undefined;
  }

  const children = getChildElements(spPr);

  if (children.some((el) => el.name === "a:noFill")) {
    return { type: "none" };
  }

  const solidFill = children.find((el) => el.name === "a:solidFill");
  if (solidFill) {
    const color = parseColorElement(solidFill);
    return color !== undefined ? { type: "solid", color } : { type: "solid" };
  }

  if (children.some((el) => el.name === "a:gradFill")) {
    return { type: "gradient" };
  }

  return undefined;
}

/**
 * Parse outline from shape properties (a:ln).
 */
export function parseOutline(
  spPr: XmlElement | null,
): ShapeOutline | undefined {
  const ln = spPr ? findByFullName(spPr, "a:ln") : null;
  if (!ln) {
    return undefined;
  }

  const children = getChildElements(ln);

  if (children.some((el) => el.name === "a:noFill")) {
    return undefined;
  }

  const outline: ShapeOutline = {};

  const w = getAttribute(ln, null, "w");
  if (w) {
    outline.width = Number.parseInt(w, 10);
  }

  const solidFill = children.find((el) => el.name === "a:solidFill");
  if (solidFill) {
    const color = parseColorElement(solidFill);
    if (color !== undefined) {
      outline.color = color;
    }
  }

  const prstDash = children.find((el) => el.name === "a:prstDash");
  if (prstDash) {
    const val = narrowEnum(
      getAttribute(prstDash, null, "val"),
      ShapeOutlineStyleSchema,
    );
    if (val) {
      outline.style = val;
    }
  }

  return outline;
}

// ============================================================================
// POSITION PARSING
// ============================================================================

/**
 * Parse horizontal position from wp:positionH element.
 */
export function parsePositionH(
  posH: XmlElement | null,
): ImagePosition["horizontal"] | undefined {
  if (!posH) {
    return undefined;
  }

  const relativeTo =
    narrowEnum(
      getAttribute(posH, null, "relativeFrom"),
      ImageHorizontalRelativeToSchema,
    ) ?? "column";

  const alignEl = findByFullName(posH, "wp:align");
  if (alignEl) {
    const text = getTextContent(alignEl);
    const result: ImagePosition["horizontal"] = { relativeTo };
    const alignment = narrowEnum(text, ImageHorizontalAlignmentSchema);
    if (alignment) {
      result.alignment = alignment;
    }
    return result;
  }

  const posOffsetEl = findByFullName(posH, "wp:posOffset");
  if (posOffsetEl) {
    const text = getTextContent(posOffsetEl);
    const posOffset = Number.parseInt(text, 10);
    return {
      relativeTo,
      posOffset: Number.isNaN(posOffset) ? 0 : posOffset,
    };
  }

  return { relativeTo };
}

/**
 * Parse vertical position from wp:positionV element.
 */
export function parsePositionV(
  posV: XmlElement | null,
): ImagePosition["vertical"] | undefined {
  if (!posV) {
    return undefined;
  }

  const relativeTo =
    narrowEnum(
      getAttribute(posV, null, "relativeFrom"),
      ImageVerticalRelativeToSchema,
    ) ?? "paragraph";

  const alignEl = findByFullName(posV, "wp:align");
  if (alignEl) {
    const text = getTextContent(alignEl);
    const result: ImagePosition["vertical"] = { relativeTo };
    const alignment = narrowEnum(text, ImageVerticalAlignmentSchema);
    if (alignment) {
      result.alignment = alignment;
    }
    return result;
  }

  const posOffsetEl = findByFullName(posV, "wp:posOffset");
  if (posOffsetEl) {
    const text = getTextContent(posOffsetEl);
    const posOffset = Number.parseInt(text, 10);
    return {
      relativeTo,
      posOffset: Number.isNaN(posOffset) ? 0 : posOffset,
    };
  }

  return { relativeTo };
}

/**
 * Parse position for anchored drawings (combines positionH + positionV).
 */
export function parseAnchorPosition(
  anchor: XmlElement,
): ImagePosition | undefined {
  const positionH = findByFullName(anchor, "wp:positionH");
  const positionV = findByFullName(anchor, "wp:positionV");

  if (!positionH && !positionV) {
    return undefined;
  }

  return {
    horizontal: parsePositionH(positionH) ?? { relativeTo: "column" },
    vertical: parsePositionV(positionV) ?? { relativeTo: "paragraph" },
  };
}

// ============================================================================
// WRAP PARSING
// ============================================================================

/** Known wrap element names */
export const WRAP_ELEMENT_NAMES = [
  "wp:wrapNone",
  "wp:wrapSquare",
  "wp:wrapTight",
  "wp:wrapThrough",
  "wp:wrapTopAndBottom",
];

/**
 * Parse wrap settings from a wrap element.
 *
 * Distance attributes (distT/distB/distL/distR) can appear on both
 * the anchor element and the wrap child. Wrap child values take priority;
 * anchor-level values are used as fallbacks.
 */
export function parseWrapElement(
  wrapEl: XmlElement | null,
  behindDoc: boolean,
  anchorDistances?: {
    distT?: number;
    distB?: number;
    distL?: number;
    distR?: number;
  },
): ImageWrap {
  if (!wrapEl) {
    const wrap: ImageWrap = { type: behindDoc ? "behind" : "inFront" };
    if (anchorDistances?.distT !== undefined) {
      wrap.distT = anchorDistances.distT;
    }
    if (anchorDistances?.distB !== undefined) {
      wrap.distB = anchorDistances.distB;
    }
    if (anchorDistances?.distL !== undefined) {
      wrap.distL = anchorDistances.distL;
    }
    if (anchorDistances?.distR !== undefined) {
      wrap.distR = anchorDistances.distR;
    }
    return wrap;
  }

  const wrapName = wrapEl.name || "";
  const wrapType = wrapName.replace("wp:", "");

  let type: ImageWrap["type"];
  switch (wrapType) {
    case "wrapNone":
      type = behindDoc ? "behind" : "inFront";
      break;
    case "wrapSquare":
      type = "square";
      break;
    case "wrapTight":
      type = "tight";
      break;
    case "wrapThrough":
      type = "through";
      break;
    case "wrapTopAndBottom":
      type = "topAndBottom";
      break;
    default:
      type = "square";
  }

  const wrap: ImageWrap = { type };

  const wrapText = narrowEnum(
    getAttribute(wrapEl, null, "wrapText"),
    ImageWrapTextSchema,
  );
  if (wrapText) {
    wrap.wrapText = wrapText;
  }

  // Wrap child distances take priority, then anchor-level
  const distT =
    parseNumericAttribute(wrapEl, null, "distT") ?? anchorDistances?.distT;
  const distB =
    parseNumericAttribute(wrapEl, null, "distB") ?? anchorDistances?.distB;
  const distL =
    parseNumericAttribute(wrapEl, null, "distL") ?? anchorDistances?.distL;
  const distR =
    parseNumericAttribute(wrapEl, null, "distR") ?? anchorDistances?.distR;

  if (distT !== undefined) {
    wrap.distT = distT;
  }
  if (distB !== undefined) {
    wrap.distB = distB;
  }
  if (distL !== undefined) {
    wrap.distL = distL;
  }
  if (distR !== undefined) {
    wrap.distR = distR;
  }

  return wrap;
}

/**
 * Parse wrap from an anchor element (finds wrap child internally).
 */
export function parseAnchorWrap(anchor: XmlElement): ImageWrap | undefined {
  const children = getChildElements(anchor);
  const behindDoc = getAttribute(anchor, null, "behindDoc") === "1";

  const wrapEl = children.find((el) =>
    WRAP_ELEMENT_NAMES.includes(el.name ?? ""),
  );

  // Read anchor-level distance fallbacks
  const distT = parseNumericAttribute(anchor, null, "distT");
  const distB = parseNumericAttribute(anchor, null, "distB");
  const distL = parseNumericAttribute(anchor, null, "distL");
  const distR = parseNumericAttribute(anchor, null, "distR");
  const anchorDistances = {
    ...(distT != null ? { distT } : {}),
    ...(distB != null ? { distB } : {}),
    ...(distL != null ? { distL } : {}),
    ...(distR != null ? { distR } : {}),
  };

  return parseWrapElement(wrapEl ?? null, behindDoc, anchorDistances);
}

// ============================================================================
// COLOR RESOLUTION (for shapes/text boxes without theme context)
// ============================================================================

/**
 * Default theme color fallbacks (Office 2016 defaults).
 * Used when resolving theme colors without a Theme object.
 */
const DEFAULT_THEME_COLOR_HEX: Record<string, string> = {
  accent1: "5B9BD5",
  accent2: "ED7D31",
  accent3: "A5A5A5",
  accent4: "FFC000",
  accent5: "4472C4",
  accent6: "70AD47",
  dk1: "000000",
  lt1: "FFFFFF",
  dk2: "1F497D",
  lt2: "EEECE1",
  text1: "000000",
  text2: "1F497D",
  background1: "FFFFFF",
  background2: "EEECE1",
  hlink: "0563C1",
  folHlink: "954F72",
};

/**
 * Resolve a ColorValue to a CSS hex string using default theme colors.
 * For use when no Theme object is available (e.g., shape/text box parsing).
 */
export function resolveColorValueToHex(
  color: ColorValue | undefined,
): string | undefined {
  if (!color) {
    return undefined;
  }

  if (color.rgb) {
    return `#${color.rgb}`;
  }

  if (color.themeColor) {
    return `#${DEFAULT_THEME_COLOR_HEX[color.themeColor] ?? "000000"}`;
  }

  return undefined;
}
