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
  elementToXml,
  findChild,
  findChildren,
  findDeep,
  getAttribute,
  getLocalName,
  getTextContent,
  type XmlElement,
} from "./xmlParser";

/**
 * Result of walking a header for its watermark. Carries the modeled
 * `Watermark`, the verbatim XML of the paragraph that hosts the
 * watermark shape (replayed on serialize so an untouched DOCX
 * round-trips byte-exact), and a reference to that hosting paragraph
 * so the regular body parser can skip it.
 */
export type ParsedWatermark = {
  watermark: Watermark;
  rawParagraphXml: string;
  hostingParagraph: XmlElement;
  /**
   * Index where the watermark paragraph sat among block-level siblings
   * (`w:p` / `w:tbl`) in the source header. After the host paragraph is
   * filtered out of `content`, the serializer inserts the watermark
   * back at this index so a header that originally placed the
   * watermark after visible text rounds-trips with the same flow.
   */
  blockIndex: number;
};

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
 *
 * Returns the modeled `Watermark`, the verbatim XML of the hosting
 * paragraph (so the serializer can replay it byte-exact), and a
 * reference to that paragraph so the regular body parser can skip it.
 */
export function parseWatermark(
  header: XmlElement,
): ParsedWatermark | undefined {
  const headerXmlns = collectXmlnsDeclarations(header);
  for (const shape of collectVmlShapesWithContent(header)) {
    const watermark = readVmlWatermark(shape);
    if (watermark) {
      const hosting = findEnclosingParagraph(header, shape);
      if (hosting) {
        return {
          watermark,
          rawParagraphXml: elementToXml(
            cloneWithXmlnsDeclarations(hosting, headerXmlns),
          ),
          hostingParagraph: hosting,
          blockIndex: blockIndexOf(header, hosting),
        };
      }
    }
  }
  for (const anchor of collectDrawingMlBehindContentAnchors(header)) {
    const watermark = readDrawingMlTextWatermark(anchor);
    if (watermark) {
      const hosting = findEnclosingParagraph(header, anchor);
      if (hosting) {
        return {
          watermark,
          rawParagraphXml: elementToXml(
            cloneWithXmlnsDeclarations(hosting, headerXmlns),
          ),
          hostingParagraph: hosting,
          blockIndex: blockIndexOf(header, hosting),
        };
      }
    }
  }
  return undefined;
}

/**
 * Collect every `xmlns:*` declaration from a header element's
 * attributes. The serializer's hard-coded root namespaces only cover
 * canonical prefixes (`a`, `w`, `wp`, …); a DOCX that binds an
 * extension namespace to a non-canonical prefix would replay an
 * unbound prefix when the captured paragraph alone is emitted. We
 * carry the source declarations forward onto the captured paragraph
 * so the raw replay is self-contained regardless of prefix choice.
 */
function collectXmlnsDeclarations(header: XmlElement): Record<string, string> {
  const out: Record<string, string> = {};
  const attrs = header.attributes;
  if (!attrs) {
    return out;
  }
  for (const [key, value] of Object.entries(attrs)) {
    if ((key === "xmlns" || key.startsWith("xmlns:")) && value !== undefined) {
      out[key] = String(value);
    }
  }
  return out;
}

/**
 * Return a shallow clone of `element` whose attributes carry every
 * `xmlns:*` declaration in `xmlnsDecls`. Existing attributes (including
 * any namespace declarations the paragraph already carries) win over
 * the header-level ones.
 */
function cloneWithXmlnsDeclarations(
  element: XmlElement,
  xmlnsDecls: Record<string, string>,
): XmlElement {
  if (Object.keys(xmlnsDecls).length === 0) {
    return element;
  }
  return {
    ...element,
    attributes: { ...xmlnsDecls, ...element.attributes },
  };
}

/**
 * Index of `target` among block-level children of `header` (only
 * `w:p` and `w:tbl` count as blocks). Since the hosting paragraph
 * is filtered out of `content` after parse, this is the index the
 * serializer needs to splice the watermark XML back into so the
 * header rounds-trips with the same flow as the source.
 */
function blockIndexOf(header: XmlElement, target: XmlElement): number {
  let blockIdx = 0;
  for (const child of header.elements ?? []) {
    if (child === target) {
      return blockIdx;
    }
    if (child.type !== "element") {
      continue;
    }
    const local = getLocalName(child.name ?? "");
    if (local === "p" || local === "tbl") {
      blockIdx++;
    }
  }
  return 0;
}

/**
 * Walk back from a watermark shape / anchor to its enclosing `<w:p>`
 * inside the header. Word always wraps a watermark in its own
 * paragraph; capturing the paragraph (not the shape) means the
 * replayed XML is a self-contained body block the header serializer
 * can splice in without further wrapping.
 *
 * If the paragraph mixes the watermark with other meaningful content
 * (text runs, additional shapes), we refuse to detach — surgically
 * extracting the watermark shape from such a paragraph is out of
 * scope here, and silently dropping the rest on `setDocumentWatermark`
 * would lose data. The caller treats the watermark as unrecoverable
 * in that case; the original paragraph stays in `content` and
 * round-trips through the regular block parser.
 */
function findEnclosingParagraph(
  header: XmlElement,
  target: XmlElement,
): XmlElement | null {
  for (const child of header.elements ?? []) {
    if (child.type !== "element" || !child.name) {
      continue;
    }
    if (getLocalName(child.name) !== "p") {
      continue;
    }
    if (containsElement(child, target) && isWatermarkOnlyParagraph(child)) {
      return child;
    }
  }
  return null;
}

/**
 * A "watermark-only" paragraph carries one shape plus only
 * WordprocessingML wrappers/formatting around it. Field runs,
 * bookmarks, tabs, breaks, text, and sibling shapes are authored
 * content; those paragraphs stay in the regular header content path
 * so clearing a watermark cannot drop unrelated header data.
 */
function isWatermarkOnlyParagraph(paragraph: XmlElement): boolean {
  const counts = countParagraphShapeAndBodyContent(paragraph);
  if (counts.bodyContentCount > 0) {
    return false;
  }
  // Exactly one shape (the watermark) is the watermark-only case;
  // siblings beyond that are sibling content.
  return counts.shapeCount <= 1;
}

/**
 * Count non-shape WordprocessingML content inside a paragraph while
 * ignoring pure formatting wrappers. The shape containers themselves
 * (`w:pict` / `w:drawing`) are counted as shapes, but their descendants
 * are skipped so the watermark's own text (`a:t`, etc.) is not treated
 * as body content.
 */
function countParagraphShapeAndBodyContent(paragraph: XmlElement): {
  shapeCount: number;
  bodyContentCount: number;
} {
  let shapeCount = 0;
  let bodyContentCount = 0;

  const walkParagraph = (
    root: XmlElement,
    insidePropertyContainer: boolean,
  ): void => {
    for (const child of root.elements ?? []) {
      if (child.type !== "element") {
        continue;
      }

      const local = getLocalName(child.name ?? "");
      if (local === "pict" || local === "drawing") {
        shapeCount++;
        continue;
      }

      const childInsidePropertyContainer =
        insidePropertyContainer || isWordprocessingPropertyContainer(local);
      if (
        !childInsidePropertyContainer &&
        !isWatermarkParagraphWrapper(local)
      ) {
        bodyContentCount++;
      }

      walkParagraph(child, childInsidePropertyContainer);
    }
  };

  walkParagraph(paragraph, false);
  return { shapeCount, bodyContentCount };
}

function isWordprocessingPropertyContainer(localName: string): boolean {
  return localName.endsWith("Pr");
}

function isWatermarkParagraphWrapper(localName: string): boolean {
  return localName === "r";
}

function containsElement(root: XmlElement, target: XmlElement): boolean {
  if (root === target) {
    return true;
  }
  for (const child of root.elements ?? []) {
    if (child.type !== "element") {
      continue;
    }
    if (containsElement(child, target)) {
      return true;
    }
  }
  return false;
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
  const opacity = readVmlFillOpacity(shape);

  const watermark: Watermark = { kind: "text", text };
  if (font !== undefined) {
    watermark.font = stripQuotes(font);
  }
  if (color !== undefined) {
    watermark.color = color;
  }
  if (opacity !== undefined) {
    watermark.opacity = opacity;
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
  const watermark: Watermark = { kind: "picture", imageRId };
  const scale = readVmlPictureWatermarkScale(shape);
  if (scale !== undefined) {
    watermark.scale = scale;
  }
  // Capture the shape's real display dimensions so the source aspect ratio
  // survives a re-synthesized save. Unlike `scale` (uniform-only), these are
  // kept even when width and height scale differently from Word's default box.
  const { widthPt, heightPt } = readVmlPictureWatermarkDimensions(shape);
  if (widthPt !== undefined) {
    watermark.widthPt = widthPt;
  }
  if (heightPt !== undefined) {
    watermark.heightPt = heightPt;
  }
  if (!readVmlPictureWatermarkHasWashout(imagedata)) {
    watermark.washout = false;
  }
  return watermark;
}

// Default picture-watermark dimensions Word emits. Kept in sync with
// headerFooterSerializer's synthesis defaults so parse/set/save
// preserves uniform picture-watermark scale.
const PICTURE_WATERMARK_DEFAULT_WIDTH_PT = 415;
const PICTURE_WATERMARK_DEFAULT_HEIGHT_PT = 207;
const PICTURE_WATERMARK_SCALE_EPSILON = 0.01;
const PICTURE_WATERMARK_WASHOUT_GAIN = "19661f";
const PICTURE_WATERMARK_WASHOUT_BLACKLEVEL = "22938f";

function readVmlPictureWatermarkScale(shape: XmlElement): number | undefined {
  const shapeStyle = getAttribute(shape, null, "style") ?? "";
  const widthPt = parseInlineStyleLengthPt(shapeStyle, "width");
  const heightPt = parseInlineStyleLengthPt(shapeStyle, "height");

  if (widthPt === undefined && heightPt === undefined) {
    return undefined;
  }

  const widthScale =
    widthPt !== undefined
      ? widthPt / PICTURE_WATERMARK_DEFAULT_WIDTH_PT
      : undefined;
  const heightScale =
    heightPt !== undefined
      ? heightPt / PICTURE_WATERMARK_DEFAULT_HEIGHT_PT
      : undefined;

  if (widthScale !== undefined && heightScale !== undefined) {
    if (Math.abs(widthScale - heightScale) > PICTURE_WATERMARK_SCALE_EPSILON) {
      return undefined;
    }
    return widthScale;
  }

  return widthScale ?? heightScale;
}

function readVmlPictureWatermarkDimensions(shape: XmlElement): {
  widthPt: number | undefined;
  heightPt: number | undefined;
} {
  const shapeStyle = getAttribute(shape, null, "style") ?? "";
  return {
    widthPt: parseInlineStyleLengthPt(shapeStyle, "width"),
    heightPt: parseInlineStyleLengthPt(shapeStyle, "height"),
  };
}

function readVmlPictureWatermarkHasWashout(imagedata: XmlElement): boolean {
  return (
    getAttribute(imagedata, null, "gain") === PICTURE_WATERMARK_WASHOUT_GAIN &&
    getAttribute(imagedata, null, "blacklevel") ===
      PICTURE_WATERMARK_WASHOUT_BLACKLEVEL
  );
}

/**
 * Read the watermark's opacity from the shape's `<v:fill>` child. Word
 * accepts two boolean encodings: the decimal form (`opacity=".5"`) and
 * the fixed-point form (`opacity="32768f"`, where 65536 = fully
 * opaque). Returns `undefined` for any malformed value so the caller
 * falls back to the renderer's silver default.
 */
function readVmlFillOpacity(shape: XmlElement): number | undefined {
  const fill = findChild(shape, "v", "fill");
  if (!fill) {
    return undefined;
  }
  const raw = getAttribute(fill, null, "opacity");
  if (!raw) {
    return undefined;
  }
  if (raw.endsWith("f")) {
    const fixed = Number.parseFloat(raw.slice(0, -1));
    if (!Number.isFinite(fixed)) {
      return undefined;
    }
    return Math.max(0, Math.min(1, fixed / 65_536));
  }
  const decimal = Number.parseFloat(raw);
  if (!Number.isFinite(decimal)) {
    return undefined;
  }
  return Math.max(0, Math.min(1, decimal));
}

function readVmlFillColor(shape: XmlElement): string | undefined {
  const raw = getAttribute(shape, null, "fillcolor");
  if (!raw) {
    return undefined;
  }
  // Word emits `fillcolor="#C0C0C0"` for the default light-gray text
  // watermark. Strip the leading `#` so the model holds the bare hex.
  // The documented `"auto"` sentinel is preserved lowercase — the
  // renderer/serializer special-case the exact lowercase form when
  // mapping back to Word's silver default; an uppercased `"AUTO"`
  // would round-trip as the invalid CSS color `#AUTO`.
  const stripped = raw.startsWith("#") ? raw.slice(1) : raw;
  return stripped.toLowerCase() === "auto" ? "auto" : stripped.toUpperCase();
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
    if (!anchor) {
      continue;
    }
    // Accept both XSD boolean serializations. ECMA-376 allows
    // `behindDoc="1"` (Word's default) and `behindDoc="true"`
    // (the equally valid xsd:boolean form some producers emit).
    const behindDoc = getAttribute(anchor, null, "behindDoc");
    if (behindDoc === "1" || behindDoc === "true") {
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

const CSS_LENGTH_RE = /^([+-]?(?:\d+|\d*\.\d+))(pt|in|cm|mm|px)?$/iu;

function parseInlineStyleLengthPt(
  style: string,
  key: string,
): number | undefined {
  const raw = parseInlineStyle(style, key);
  if (raw === undefined) {
    return undefined;
  }
  const match = CSS_LENGTH_RE.exec(raw.trim());
  const amountText = match?.at(1);
  if (amountText === undefined) {
    return undefined;
  }
  const amount = Number.parseFloat(amountText);
  if (!Number.isFinite(amount) || amount <= 0) {
    return undefined;
  }
  const unit = match?.at(2)?.toLowerCase() ?? "pt";
  if (unit === "pt") {
    return amount;
  }
  if (unit === "in") {
    return amount * 72;
  }
  if (unit === "cm") {
    return (amount * 72) / 2.54;
  }
  if (unit === "mm") {
    return (amount * 72) / 25.4;
  }
  if (unit === "px") {
    return amount * 0.75;
  }
  return undefined;
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
