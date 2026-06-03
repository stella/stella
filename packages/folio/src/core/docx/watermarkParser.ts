/**
 * Watermark detection inside a `<w:hdr>` element.
 *
 * Word emits watermarks behind page content via:
 *
 * - VML WordArt: `<w:pict><v:shape type="#_x0000_t136"><v:textpath
 *   string="…"/></v:shape></w:pict>` for text watermarks. The de-facto
 *   interchange shape — used by Word, LibreOffice, and most legacy
 *   templating tools.
 * - VML picture: `<v:shape><v:imagedata r:id="…"/></v:shape>` for
 *   picture watermarks.
 * - DrawingML behind-content shape: `<w:drawing><wp:anchor behindDoc="1">
 *   …` in modern producers. Not part of the upstream
 *   eigenpal/docx-editor#679 port; folio detects it so DOCX files from
 *   recent Office builds and from generators like Aspose round-trip
 *   without dropping the watermark.
 *
 * The walker is structural — it traverses the parsed XML tree rather
 * than the modeled `BlockContent`, because folio's body parser does
 * not surface VML shapes or DrawingML graphic data at the run level.
 */

import type { Watermark } from "../types/document";
import {
  findChild,
  findChildren,
  findDeep,
  getAttribute,
  getLocalName,
  getTextContent,
  type XmlElement,
} from "./xmlParser";

const VML_TEXT_WATERMARK_SHAPETYPE = "#_x0000_t136";
/**
 * Word's own UI emits picture watermarks with a shape id beginning
 * `WordPictureWatermark`. A logo image dropped into a header from the
 * ribbon gets a plain auto-id like `_x0000_s1025`, so this prefix is
 * the cleanest signal to separate real picture watermarks from
 * ordinary header imagery.
 */
const VML_PICTURE_WATERMARK_ID_PREFIX = "WordPictureWatermark";

/**
 * Walk a parsed `<w:hdr>` element and return the watermark it carries,
 * or `undefined` when none is present. Scans every candidate shape /
 * anchor in the header so a non-watermark shape (e.g. a logo image)
 * earlier in document order does not shadow the real watermark.
 */
export function parseWatermark(header: XmlElement): Watermark | undefined {
  for (const shape of collectVmlShapesWithContent(header)) {
    const watermark = readVmlWatermark(shape);
    if (watermark) {
      return watermark;
    }
  }
  for (const anchor of collectDrawingMlBehindContentAnchors(header)) {
    const watermark = readDrawingMlTextWatermark(anchor);
    if (watermark) {
      return watermark;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// VML detection (w:pict > v:shape)
// ---------------------------------------------------------------------------

function collectVmlShapesWithContent(header: XmlElement): XmlElement[] {
  const out: XmlElement[] = [];
  for (const pict of collectByLocalName(header, "pict")) {
    for (const shape of findChildren(pict, "v", "shape")) {
      if (
        findChild(shape, "v", "textpath") ||
        findChild(shape, "v", "imagedata")
      ) {
        out.push(shape);
      }
    }
  }
  return out;
}

function readVmlWatermark(shape: XmlElement): Watermark | null {
  const textpath = findChild(shape, "v", "textpath");
  if (textpath) {
    return readVmlTextWatermark(shape, textpath);
  }
  const imagedata = findChild(shape, "v", "imagedata");
  if (imagedata) {
    return readVmlPictureWatermark(shape, imagedata);
  }
  return null;
}

function readVmlTextWatermark(
  shape: XmlElement,
  textpath: XmlElement,
): Watermark | null {
  const text = getAttribute(textpath, null, "string") ?? "";
  if (text.length === 0) {
    return null;
  }
  const shapeStyle = getAttribute(shape, null, "style") ?? "";
  const shapeType = getAttribute(shape, null, "type") ?? "";
  // Anchor on the WordArt shapetype Word uses for text watermarks. Other
  // VML shapes inside a header (page borders, decorative elements) do
  // carry textpaths too and should not be promoted to watermarks.
  if (shapeType !== VML_TEXT_WATERMARK_SHAPETYPE) {
    return null;
  }
  const textpathStyle = getAttribute(textpath, null, "style") ?? "";
  const font = parseInlineStyle(textpathStyle, "font-family");
  const color = readVmlFillColor(shape);
  const rotation = parseInlineStyleNumber(shapeStyle, "rotation");

  const watermark: Watermark = { kind: "text", text };
  if (font !== undefined) {
    watermark.font = stripQuotes(font);
  }
  if (color !== undefined) {
    watermark.color = color;
  }
  // Word emits diagonal = -45° as `rotation:315` (the equivalent
  // unsigned angle). Horizontal watermarks emit rotation:0 or omit it.
  if (rotation !== undefined) {
    watermark.diagonal = rotation === 315 || rotation === -45;
  }
  return watermark;
}

function readVmlPictureWatermark(
  shape: XmlElement,
  imagedata: XmlElement,
): Watermark | null {
  // Word distinguishes picture watermarks from ordinary header images by
  // stamping a `WordPictureWatermark…` id on the wrapping `<v:shape>`.
  // Without this check, a company logo dropped into the header would
  // round-trip as a watermark on save — silently turning a logo into a
  // full-page behind-content image.
  const shapeId = getAttribute(shape, null, "id") ?? "";
  if (!shapeId.startsWith(VML_PICTURE_WATERMARK_ID_PREFIX)) {
    return null;
  }
  const imageRId =
    getAttribute(imagedata, "r", "id") ?? getAttribute(imagedata, null, "id");
  if (!imageRId) {
    return null;
  }
  return { kind: "picture", imageRId };
}

function readVmlFillColor(shape: XmlElement): string | undefined {
  const raw = getAttribute(shape, null, "fillcolor");
  if (!raw) {
    return undefined;
  }
  // Word emits `fillcolor="#C0C0C0"` for the default light-gray text
  // watermark. Strip the leading `#` so the model holds the bare hex.
  return raw.startsWith("#") ? raw.slice(1).toUpperCase() : raw.toUpperCase();
}

// ---------------------------------------------------------------------------
// DrawingML detection (w:drawing > wp:anchor with behindDoc="1")
// ---------------------------------------------------------------------------

function collectDrawingMlBehindContentAnchors(
  header: XmlElement,
): XmlElement[] {
  const out: XmlElement[] = [];
  for (const drawing of collectByLocalName(header, "drawing")) {
    const anchor = findDeep(drawing, "wp", "anchor");
    if (anchor && getAttribute(anchor, null, "behindDoc") === "1") {
      out.push(anchor);
    }
  }
  return out;
}

function readDrawingMlTextWatermark(anchor: XmlElement): Watermark | undefined {
  const text = readDrawingMlTextBody(anchor);
  if (!text) {
    return undefined;
  }
  const font = readDrawingMlFontFamily(anchor);
  const watermark: Watermark = { kind: "text", text };
  if (font !== undefined) {
    watermark.font = font;
  }
  return watermark;
}

function readDrawingMlTextBody(anchor: XmlElement): string | null {
  // <a:txBody><a:p><a:r><a:t>...</a:t></a:r></a:p></a:txBody>
  const txBody = findDeep(anchor, "a", "txBody");
  if (!txBody) {
    return null;
  }
  const parts: string[] = [];
  for (const p of findChildren(txBody, "a", "p")) {
    for (const r of findChildren(p, "a", "r")) {
      const t = findChild(r, "a", "t");
      if (t) {
        parts.push(getTextContent(t));
      }
    }
  }
  const joined = parts.join("");
  return joined.length > 0 ? joined : null;
}

function readDrawingMlFontFamily(anchor: XmlElement): string | undefined {
  // <a:rPr><a:latin typeface="..."/></a:rPr>
  const latin = findDeep(anchor, "a", "latin");
  if (!latin) {
    return undefined;
  }
  const typeface = getAttribute(latin, null, "typeface");
  return typeface ?? undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function collectByLocalName(root: XmlElement, localName: string): XmlElement[] {
  const out: XmlElement[] = [];
  walk(root, (el) => {
    if (getLocalName(el.name ?? "") === localName) {
      out.push(el);
    }
  });
  return out;
}

function walk(root: XmlElement, visit: (el: XmlElement) => void): void {
  for (const child of root.elements ?? []) {
    if (child.type !== "element") {
      continue;
    }
    visit(child);
    walk(child, visit);
  }
}

function parseInlineStyle(style: string, key: string): string | undefined {
  // CSS-style key/value pairs separated by `;`. Word emits values that may
  // contain single-quoted commas (`font-family:'Calibri','sans-serif'`); the
  // semicolon split is fine because Word never embeds a literal `;` inside
  // a value.
  //
  // Producers sometimes pad the colon (`rotation : 315`, `font-family :
  // Calibri`), so split each declaration at the first colon rather than
  // requiring `key:` to be a prefix.
  const lowerKey = key.toLowerCase();
  for (const part of style.split(";")) {
    const colonIdx = part.indexOf(":");
    if (colonIdx === -1) {
      continue;
    }
    if (part.slice(0, colonIdx).trim().toLowerCase() === lowerKey) {
      return part.slice(colonIdx + 1).trim();
    }
  }
  return undefined;
}

function parseInlineStyleNumber(
  style: string,
  key: string,
): number | undefined {
  const raw = parseInlineStyle(style, key);
  if (raw === undefined) {
    return undefined;
  }
  const num = Number.parseFloat(raw);
  return Number.isFinite(num) ? num : undefined;
}

function stripQuotes(value: string): string {
  // Peel off comma-separated fallback families BEFORE checking for
  // matched quotes. For `'Calibri','sans-serif'` the previous logic
  // saw matching `'` at both ends and stripped one char from each,
  // yielding `Calibri','sans-serif` instead of `Calibri`.
  let primary = value;
  const commaIdx = primary.indexOf(",");
  if (commaIdx !== -1) {
    primary = primary.slice(0, commaIdx).trim();
  }
  const matchedDouble = primary.startsWith('"') && primary.endsWith('"');
  const matchedSingle = primary.startsWith("'") && primary.endsWith("'");
  if (primary.length >= 2 && (matchedDouble || matchedSingle)) {
    return primary.slice(1, -1);
  }
  return primary;
}
