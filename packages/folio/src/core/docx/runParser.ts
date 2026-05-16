/**
 * Run Parser - Parse text runs (w:r) with complete formatting
 *
 * A run is a contiguous region of text with the same character formatting.
 * Runs can contain:
 * - Text (w:t)
 * - Tabs (w:tab)
 * - Line breaks (w:br)
 * - Symbols (w:sym)
 * - Footnote/endnote references
 * - Field characters
 * - Drawings/images (w:drawing)
 * - And more...
 *
 * OOXML Reference:
 * - Run: w:r
 * - Run properties: w:rPr
 * - Text content: w:t
 */

import type {
  Run,
  RunContent,
  TextContent,
  TabContent,
  BreakContent,
  SymbolContent,
  NoteReferenceContent,
  FieldCharContent,
  InstrTextContent,
  SoftHyphenContent,
  NoBreakHyphenContent,
  DrawingContent,
  RunPropertyChange,
  TextFormatting,
  ColorValue,
  ShadingProperties,
  Theme,
  Image,
  RelationshipMap,
  MediaFile,
} from "../types/document";
import { parseImage } from "./imageParser";
import {
  EmphasisMarkSchema,
  FontThemeSchema,
  HighlightColorSchema,
  ShadingPatternSchema,
  TextEffectSchema,
  ThemeColorSlotSchema,
  UnderlineStyleSchema,
  narrowEnum,
} from "./parserEnums";
import type { StyleMap } from "./styleParser";
import { resolveThemeFontRef } from "./themeParser";
import {
  findChild,
  findChildren,
  getAttribute,
  getChildElements,
  getTextContent,
  parseBooleanElement,
  parseNumericAttribute,
  elementToXml,
} from "./xmlParser";
import type { XmlElement } from "./xmlParser";

/**
 * Parse color value from attributes
 */
function parseColorValue(
  rgb: string | null,
  themeColor: string | null,
  themeTint: string | null,
  themeShade: string | null,
): ColorValue {
  const color: ColorValue = {};

  if (rgb && rgb !== "auto") {
    color.rgb = rgb;
  } else if (rgb === "auto") {
    color.auto = true;
  }

  const validatedThemeColor = narrowEnum(themeColor, ThemeColorSlotSchema);
  if (validatedThemeColor) {
    color.themeColor = validatedThemeColor;
  }

  if (themeTint) {
    color.themeTint = themeTint;
  }

  if (themeShade) {
    color.themeShade = themeShade;
  }

  return color;
}

/**
 * Parse shading properties (w:shd)
 */
function parseShadingProperties(
  shd: XmlElement | null,
): ShadingProperties | undefined {
  if (!shd) {
    return undefined;
  }

  const props: ShadingProperties = {};

  const color = getAttribute(shd, "w", "color");
  if (color && color !== "auto") {
    props.color = { rgb: color };
  }

  const fill = getAttribute(shd, "w", "fill");
  if (fill && fill !== "auto") {
    props.fill = { rgb: fill };
  }

  const themeFill = getAttribute(shd, "w", "themeFill");
  const validatedThemeFill = narrowEnum(themeFill, ThemeColorSlotSchema);
  if (validatedThemeFill) {
    if (!props.fill) {
      props.fill = {};
    }
    props.fill.themeColor = validatedThemeFill;
  }

  const themeFillTint = getAttribute(shd, "w", "themeFillTint");
  if (themeFillTint && props.fill) {
    props.fill.themeTint = themeFillTint;
  }

  const themeFillShade = getAttribute(shd, "w", "themeFillShade");
  if (themeFillShade && props.fill) {
    props.fill.themeShade = themeFillShade;
  }

  const pattern = narrowEnum(
    getAttribute(shd, "w", "val"),
    ShadingPatternSchema,
  );
  if (pattern) {
    props.pattern = pattern;
  }

  return Object.keys(props).length > 0 ? props : undefined;
}

/**
 * Parse run formatting properties (w:rPr)
 *
 * Handles ALL rPr properties:
 * - w:b (bold), w:i (italic), w:u (underline with style)
 * - w:strike (strikethrough), w:dstrike (double strike)
 * - w:vertAlign (superscript/subscript)
 * - w:smallCaps, w:caps (capitalization)
 * - w:highlight (text highlight color)
 * - w:shd (character shading)
 * - w:color (text color with theme resolution)
 * - w:sz (font size in half-points)
 * - w:rFonts (font family with theme resolution)
 * - w:spacing (character spacing)
 * - w:effect (text effects)
 * - And more...
 */
export function parseRunProperties(
  rPr: XmlElement | null,
  theme: Theme | null,
  _styles?: StyleMap,
): TextFormatting | undefined {
  if (!rPr) {
    return undefined;
  }

  const formatting: TextFormatting = {};

  // Bold (w:b)
  const b = findChild(rPr, "w", "b");
  if (b) {
    formatting.bold = parseBooleanElement(b);
  }

  const bCs = findChild(rPr, "w", "bCs");
  if (bCs) {
    formatting.boldCs = parseBooleanElement(bCs);
  }

  // Italic (w:i)
  const i = findChild(rPr, "w", "i");
  if (i) {
    formatting.italic = parseBooleanElement(i);
  }

  const iCs = findChild(rPr, "w", "iCs");
  if (iCs) {
    formatting.italicCs = parseBooleanElement(iCs);
  }

  // Underline (w:u)
  const u = findChild(rPr, "w", "u");
  if (u) {
    const style = narrowEnum(getAttribute(u, "w", "val"), UnderlineStyleSchema);
    if (style) {
      formatting.underline = { style };
      const colorVal = getAttribute(u, "w", "color");
      const themeColor = getAttribute(u, "w", "themeColor");
      if (colorVal || themeColor) {
        formatting.underline.color = parseColorValue(
          colorVal,
          themeColor,
          getAttribute(u, "w", "themeTint"),
          getAttribute(u, "w", "themeShade"),
        );
      }
    }
  }

  // Strikethrough (w:strike)
  const strike = findChild(rPr, "w", "strike");
  if (strike) {
    formatting.strike = parseBooleanElement(strike);
  }

  // Double strikethrough (w:dstrike)
  const dstrike = findChild(rPr, "w", "dstrike");
  if (dstrike) {
    formatting.doubleStrike = parseBooleanElement(dstrike);
  }

  // Vertical alignment - superscript/subscript (w:vertAlign)
  const vertAlign = findChild(rPr, "w", "vertAlign");
  if (vertAlign) {
    const val = getAttribute(vertAlign, "w", "val");
    if (val === "superscript" || val === "subscript" || val === "baseline") {
      formatting.vertAlign = val;
    }
  }

  // Small caps (w:smallCaps)
  const smallCaps = findChild(rPr, "w", "smallCaps");
  if (smallCaps) {
    formatting.smallCaps = parseBooleanElement(smallCaps);
  }

  // All caps (w:caps)
  const caps = findChild(rPr, "w", "caps");
  if (caps) {
    formatting.allCaps = parseBooleanElement(caps);
  }

  // Hidden text (w:vanish)
  const vanish = findChild(rPr, "w", "vanish");
  if (vanish) {
    formatting.hidden = parseBooleanElement(vanish);
  }

  // Text color (w:color)
  const color = findChild(rPr, "w", "color");
  if (color) {
    formatting.color = parseColorValue(
      getAttribute(color, "w", "val"),
      getAttribute(color, "w", "themeColor"),
      getAttribute(color, "w", "themeTint"),
      getAttribute(color, "w", "themeShade"),
    );
  }

  // Highlight color (w:highlight)
  const highlight = findChild(rPr, "w", "highlight");
  if (highlight) {
    const val = narrowEnum(
      getAttribute(highlight, "w", "val"),
      HighlightColorSchema,
    );
    if (val) {
      formatting.highlight = val;
    }
  }

  // Character shading (w:shd)
  const shd = findChild(rPr, "w", "shd");
  if (shd) {
    const shadingResult = parseShadingProperties(shd);
    if (shadingResult) {
      formatting.shading = shadingResult;
    }
  }

  // Font size in half-points (w:sz)
  const sz = findChild(rPr, "w", "sz");
  if (sz) {
    const val = parseNumericAttribute(sz, "w", "val");
    if (val !== undefined) {
      formatting.fontSize = val;
    }
  }

  // Font size complex script (w:szCs)
  const szCs = findChild(rPr, "w", "szCs");
  if (szCs) {
    const val = parseNumericAttribute(szCs, "w", "val");
    if (val !== undefined) {
      formatting.fontSizeCs = val;
    }
  }

  // Font family (w:rFonts)
  const rFonts = findChild(rPr, "w", "rFonts");
  if (rFonts) {
    const fontFamily: NonNullable<TextFormatting["fontFamily"]> = {};
    const ascii = getAttribute(rFonts, "w", "ascii");
    if (ascii) {
      fontFamily.ascii = ascii;
    }
    const hAnsi = getAttribute(rFonts, "w", "hAnsi");
    if (hAnsi) {
      fontFamily.hAnsi = hAnsi;
    }
    const eastAsia = getAttribute(rFonts, "w", "eastAsia");
    if (eastAsia) {
      fontFamily.eastAsia = eastAsia;
    }
    const csFont = getAttribute(rFonts, "w", "cs");
    if (csFont) {
      fontFamily.cs = csFont;
    }

    // Theme font references
    const asciiThemeRaw = getAttribute(rFonts, "w", "asciiTheme");
    const asciiTheme = narrowEnum(asciiThemeRaw, FontThemeSchema);
    if (asciiTheme) {
      fontFamily.asciiTheme = asciiTheme;
      // Also resolve the actual font name for convenience
      if (theme && !fontFamily.ascii) {
        const resolved = resolveThemeFontRef(theme, asciiTheme);
        if (resolved) {
          fontFamily.ascii = resolved;
        }
      }
    }

    const hAnsiTheme = getAttribute(rFonts, "w", "hAnsiTheme");
    if (hAnsiTheme) {
      fontFamily.hAnsiTheme = hAnsiTheme;
      if (theme && !fontFamily.hAnsi) {
        const resolved = resolveThemeFontRef(theme, hAnsiTheme);
        if (resolved) {
          fontFamily.hAnsi = resolved;
        }
      }
    }

    const eastAsiaTheme = getAttribute(rFonts, "w", "eastAsiaTheme");
    if (eastAsiaTheme) {
      fontFamily.eastAsiaTheme = eastAsiaTheme;
      if (theme && !fontFamily.eastAsia) {
        const resolved = resolveThemeFontRef(theme, eastAsiaTheme);
        if (resolved) {
          fontFamily.eastAsia = resolved;
        }
      }
    }

    const csTheme = getAttribute(rFonts, "w", "cstheme");
    if (csTheme) {
      fontFamily.csTheme = csTheme;
      if (theme && !fontFamily.cs) {
        const resolved = resolveThemeFontRef(theme, csTheme);
        if (resolved) {
          fontFamily.cs = resolved;
        }
      }
    }

    formatting.fontFamily = fontFamily;
  }

  // Character spacing in twips (w:spacing)
  const spacing = findChild(rPr, "w", "spacing");
  if (spacing) {
    const val = parseNumericAttribute(spacing, "w", "val");
    if (val !== undefined) {
      formatting.spacing = val;
    }
  }

  // Position - raised/lowered in half-points (w:position)
  const position = findChild(rPr, "w", "position");
  if (position) {
    const val = parseNumericAttribute(position, "w", "val");
    if (val !== undefined) {
      formatting.position = val;
    }
  }

  // Horizontal text scale percentage (w:w)
  const w = findChild(rPr, "w", "w");
  if (w) {
    const val = parseNumericAttribute(w, "w", "val");
    if (val !== undefined) {
      formatting.scale = val;
    }
  }

  // Kerning threshold in half-points (w:kern)
  const kern = findChild(rPr, "w", "kern");
  if (kern) {
    const val = parseNumericAttribute(kern, "w", "val");
    if (val !== undefined) {
      formatting.kerning = val;
    }
  }

  // Text effect animation (w:effect)
  const effect = findChild(rPr, "w", "effect");
  if (effect) {
    const val = narrowEnum(getAttribute(effect, "w", "val"), TextEffectSchema);
    if (val) {
      formatting.effect = val;
    }
  }

  // Emphasis mark (w:em)
  const em = findChild(rPr, "w", "em");
  if (em) {
    const val = narrowEnum(getAttribute(em, "w", "val"), EmphasisMarkSchema);
    if (val) {
      formatting.emphasisMark = val;
    }
  }

  // Emboss effect (w:emboss)
  const emboss = findChild(rPr, "w", "emboss");
  if (emboss) {
    formatting.emboss = parseBooleanElement(emboss);
  }

  // Imprint/engrave effect (w:imprint)
  const imprint = findChild(rPr, "w", "imprint");
  if (imprint) {
    formatting.imprint = parseBooleanElement(imprint);
  }

  // Outline effect (w:outline)
  const outline = findChild(rPr, "w", "outline");
  if (outline) {
    formatting.outline = parseBooleanElement(outline);
  }

  // Shadow effect (w:shadow)
  const shadow = findChild(rPr, "w", "shadow");
  if (shadow) {
    formatting.shadow = parseBooleanElement(shadow);
  }

  // Right-to-left text (w:rtl)
  const rtl = findChild(rPr, "w", "rtl");
  if (rtl) {
    formatting.rtl = parseBooleanElement(rtl);
  }

  // Complex script formatting (w:cs)
  const cs = findChild(rPr, "w", "cs");
  if (cs) {
    formatting.cs = parseBooleanElement(cs);
  }

  // Character style reference (w:rStyle)
  const rStyle = findChild(rPr, "w", "rStyle");
  if (rStyle) {
    const val = getAttribute(rStyle, "w", "val");
    if (val) {
      formatting.styleId = val;
    }
  }

  return Object.keys(formatting).length > 0 ? formatting : undefined;
}

function parsePropertyChangeInfo(
  changeElement: XmlElement,
): RunPropertyChange["info"] {
  const rawId = getAttribute(changeElement, "w", "id");
  const parsedId = rawId ? Number.parseInt(rawId, 10) : 0;
  const author = (getAttribute(changeElement, "w", "author") ?? "").trim();
  const date = (getAttribute(changeElement, "w", "date") ?? "").trim();
  const rsid = (getAttribute(changeElement, "w", "rsid") ?? "").trim();

  const info: RunPropertyChange["info"] = {
    id: Number.isInteger(parsedId) && parsedId >= 0 ? parsedId : 0,
    author: author.length > 0 ? author : "Unknown",
  };
  if (date.length > 0) {
    info.date = date;
  }
  if (rsid.length > 0) {
    info.rsid = rsid;
  }

  return info;
}

function parseRunPropertyChanges(
  rPr: XmlElement | null,
  theme: Theme | null,
  styles: StyleMap | null,
  currentFormatting: TextFormatting | undefined,
): RunPropertyChange[] | undefined {
  if (!rPr) {
    return undefined;
  }

  const changes = findChildren(rPr, "w", "rPrChange")
    .map((changeElement): RunPropertyChange => {
      const previousRPr = findChild(changeElement, "w", "rPr");
      const change: RunPropertyChange = {
        type: "runPropertyChange",
        info: parsePropertyChangeInfo(changeElement),
      };
      const previousFormatting = parseRunProperties(
        previousRPr,
        theme,
        styles ?? undefined,
      );
      if (previousFormatting) {
        change.previousFormatting = previousFormatting;
      }
      if (currentFormatting) {
        change.currentFormatting = currentFormatting;
      }
      return change;
    })
    .filter((change) => change.previousFormatting || change.currentFormatting);

  return changes.length > 0 ? changes : undefined;
}

/**
 * Parse text content (w:t)
 */
function parseTextContent(element: XmlElement): TextContent {
  const text = getTextContent(element);
  const preserveSpace = getAttribute(element, "xml", "space") === "preserve";

  const content: TextContent = { type: "text", text };
  if (preserveSpace) {
    content.preserveSpace = true;
  }
  return content;
}

/**
 * Parse tab element (w:tab)
 */
function parseTabContent(): TabContent {
  return { type: "tab" };
}

/**
 * Parse break element (w:br)
 */
function parseBreakContent(element: XmlElement): BreakContent {
  const breakType = getAttribute(element, "w", "type");
  const clear = getAttribute(element, "w", "clear");

  const content: BreakContent = { type: "break" };

  if (
    breakType === "page" ||
    breakType === "column" ||
    breakType === "textWrapping"
  ) {
    content.breakType = breakType;
  }

  if (
    clear === "none" ||
    clear === "left" ||
    clear === "right" ||
    clear === "all"
  ) {
    content.clear = clear;
  }

  return content;
}

/**
 * Parse symbol element (w:sym)
 */
function parseSymbolContent(element: XmlElement): SymbolContent {
  const font = getAttribute(element, "w", "font") ?? "";
  const char = getAttribute(element, "w", "char") ?? "";

  return {
    type: "symbol",
    font,
    char,
  };
}

/**
 * Parse footnote reference (w:footnoteReference)
 */
function parseFootnoteReference(element: XmlElement): NoteReferenceContent {
  const id = parseNumericAttribute(element, "w", "id") ?? 0;

  return {
    type: "footnoteRef",
    id,
  };
}

/**
 * Parse endnote reference (w:endnoteReference)
 */
function parseEndnoteReference(element: XmlElement): NoteReferenceContent {
  const id = parseNumericAttribute(element, "w", "id") ?? 0;

  return {
    type: "endnoteRef",
    id,
  };
}

/**
 * Parse field character (w:fldChar)
 */
function parseFieldChar(element: XmlElement): FieldCharContent {
  const fldCharType = getAttribute(element, "w", "fldCharType");
  const fldLock =
    getAttribute(element, "w", "fldLock") === "true" ||
    getAttribute(element, "w", "fldLock") === "1";
  const dirty =
    getAttribute(element, "w", "dirty") === "true" ||
    getAttribute(element, "w", "dirty") === "1";

  let charType: FieldCharContent["charType"] = "begin";
  if (fldCharType === "separate") {
    charType = "separate";
  } else if (fldCharType === "end") {
    charType = "end";
  }

  const content: FieldCharContent = { type: "fieldChar", charType };
  if (fldLock) {
    content.fldLock = true;
  }
  if (dirty) {
    content.dirty = true;
  }
  return content;
}

/**
 * Parse instruction text (w:instrText)
 */
function parseInstrText(element: XmlElement): InstrTextContent {
  const text = getTextContent(element);

  return {
    type: "instrText",
    text,
  };
}

/**
 * Parse drawing content (w:drawing)
 *
 * Uses imageParser to fully parse the drawing element including
 * image data resolution from relationships and media files.
 */
function parseDrawingContent(
  element: XmlElement,
  rels: RelationshipMap | null,
  media: Map<string, MediaFile> | null,
): DrawingContent | null {
  // Use the full imageParser to parse the drawing
  const image = parseImage(element, rels ?? undefined, media ?? undefined);

  if (!image) {
    return null;
  }

  const drawing: DrawingContent = {
    type: "drawing",
    image,
  };
  if (!image.src) {
    drawing.rawXml = elementToXml(element);
  }

  return drawing;
}

/**
 * Get the local name of an element (without namespace prefix)
 */
function getLocalName(name: string | undefined): string {
  if (!name) {
    return "";
  }
  const colonIndex = name.indexOf(":");
  return colonIndex !== -1 ? name.slice(colonIndex + 1) : name;
}

/**
 * Parse all content within a run element
 */
function parseRunContents(
  runElement: XmlElement,
  rels: RelationshipMap | null,
  media: Map<string, MediaFile> | null,
): RunContent[] {
  const contents: RunContent[] = [];
  const children = getChildElements(runElement);

  for (const child of children) {
    const localName = getLocalName(child.name);

    switch (localName) {
      case "t":
        // Text content
        contents.push(parseTextContent(child));
        break;

      case "tab":
        // Tab character
        contents.push(parseTabContent());
        break;

      case "br":
        // Line/page/column break
        contents.push(parseBreakContent(child));
        break;

      case "sym":
        // Symbol character
        contents.push(parseSymbolContent(child));
        break;

      case "footnoteReference":
        // Footnote reference
        contents.push(parseFootnoteReference(child));
        break;

      case "endnoteReference":
        // Endnote reference
        contents.push(parseEndnoteReference(child));
        break;

      case "fldChar":
        // Field character (begin/separate/end)
        contents.push(parseFieldChar(child));
        break;

      case "instrText":
        // Field instruction text
        contents.push(parseInstrText(child));
        break;

      case "softHyphen":
        // Soft hyphen
        contents.push({ type: "softHyphen" } as SoftHyphenContent);
        break;

      case "noBreakHyphen":
        // Non-breaking hyphen
        contents.push({ type: "noBreakHyphen" } as NoBreakHyphenContent);
        break;

      case "drawing": {
        // Drawing/image
        const drawing = parseDrawingContent(child, rels, media);
        if (drawing) {
          contents.push(drawing);
        }
        break;
      }

      case "pict":
      case "object":
        // Legacy VML pictures/objects are not part of the active DrawingML path.
        break;

      case "rPr":
        // Run properties - already handled separately
        break;

      case "lastRenderedPageBreak":
        // Marker for last rendered page break - informational only
        break;

      case "cr":
        // Carriage return - treat as line break
        contents.push({
          type: "break",
          breakType: "textWrapping",
        } as BreakContent);
        break;

      case "AlternateContent": {
        // mc:AlternateContent — prefer mc:Choice over mc:Fallback
        const choiceEl = getChildElements(child).find(
          (el) => getLocalName(el.name) === "Choice",
        );
        const targetEl =
          choiceEl ??
          getChildElements(child).find(
            (el) => getLocalName(el.name) === "Fallback",
          );
        if (targetEl) {
          for (const innerChild of getChildElements(targetEl)) {
            const innerName = getLocalName(innerChild.name);
            if (innerName === "drawing") {
              const innerDrawing = parseDrawingContent(innerChild, rels, media);
              // Keep package-referenced drawings even when the browser cannot render
              // the media. The serializer must preserve the relationship reference.
              if (innerDrawing) {
                if (!innerDrawing.image.src) {
                  innerDrawing.rawXml = elementToXml(child);
                }
                contents.push(innerDrawing);
              }
            }
          }
        }
        break;
      }

      case "footnoteRef":
      case "endnoteRef":
        // These are the actual footnote/endnote content markers (different from Reference)
        // They appear in the footnote/endnote text itself
        break;

      case "separator":
      case "continuationSeparator":
        // Footnote/endnote separators
        break;

      default:
        // Unknown element - log for debugging if needed
        // console.log(`Unknown run content element: ${localName}`);
        break;
    }
  }

  return contents;
}

/**
 * Parse a run element (w:r)
 *
 * @param node - The w:r XML element
 * @param styles - Style map for resolving style references
 * @param theme - Theme for resolving theme colors/fonts
 * @param rels - Relationship map for resolving image references
 * @param media - Media files map for image data
 * @returns Parsed Run object
 */
export function parseRun(
  node: XmlElement,
  styles: StyleMap | null,
  theme: Theme | null,
  rels: RelationshipMap | null = null,
  media: Map<string, MediaFile> | null = null,
): Run {
  const run: Run = {
    type: "run",
    content: [],
  };

  // Parse run properties (w:rPr)
  const rPr = findChild(node, "w", "rPr");
  if (rPr) {
    const formattingResult = parseRunProperties(
      rPr,
      theme,
      styles ?? undefined,
    );
    if (formattingResult) {
      run.formatting = formattingResult;
    }
    const propertyChangesResult = parseRunPropertyChanges(
      rPr,
      theme,
      styles,
      run.formatting,
    );
    if (propertyChangesResult) {
      run.propertyChanges = propertyChangesResult;
    }
  }

  // Parse run contents (text, tabs, breaks, images, etc.)
  run.content = parseRunContents(node, rels, media);

  return run;
}

/**
 * Get plain text from a run
 *
 * @param run - Parsed Run object
 * @returns Concatenated text content
 */
export function getRunText(run: Run): string {
  let text = "";

  for (const content of run.content) {
    if (content.type === "text") {
      text += content.text;
    } else if (content.type === "tab") {
      text += "\t";
    } else if (content.type === "break") {
      if (content.breakType === "page") {
        text += "\f"; // Form feed for page break
      } else {
        text += "\n";
      }
    } else if (content.type === "softHyphen") {
      text += "\u00AD"; // Soft hyphen Unicode
    } else if (content.type === "noBreakHyphen") {
      text += "\u2011"; // Non-breaking hyphen Unicode
    }
  }

  return text;
}

/**
 * Check if a run contains any actual content
 *
 * @param run - Parsed Run object
 * @returns true if run has visible content
 */
export function hasContent(run: Run): boolean {
  return run.content.length > 0;
}

/**
 * Check if a run contains a drawing/image
 *
 * @param run - Parsed Run object
 * @returns true if run contains an image
 */
export function hasImage(run: Run): boolean {
  return run.content.some((c) => c.type === "drawing");
}

/**
 * Get all images from a run
 *
 * @param run - Parsed Run object
 * @returns Array of Image objects
 */
export function getImages(run: Run): Image[] {
  return run.content
    .filter((c): c is DrawingContent => c.type === "drawing")
    .map((c) => c.image);
}

/**
 * Check if a run is part of a complex field
 *
 * @param run - Parsed Run object
 * @returns true if run contains field characters
 */
export function hasFieldChar(run: Run): boolean {
  return run.content.some((c) => c.type === "fieldChar");
}

/**
 * Get field character type if present
 *
 * @param run - Parsed Run object
 * @returns Field character type or null
 */
export function getFieldCharType(
  run: Run,
): "begin" | "separate" | "end" | null {
  const fieldChar = run.content.find(
    (c): c is FieldCharContent => c.type === "fieldChar",
  );
  return fieldChar?.charType ?? null;
}
