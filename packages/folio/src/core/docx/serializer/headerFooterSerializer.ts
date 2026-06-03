/**
 * Header/Footer Serializer - Serialize headers/footers to OOXML XML
 *
 * Converts HeaderFooter objects back to valid header*.xml / footer*.xml format.
 * Reuses paragraph and table serializers for content.
 *
 * OOXML Reference:
 * - Header root: w:hdr
 * - Footer root: w:ftr
 * - Content: w:p, w:tbl (same as document body)
 */

import type {
  BlockContent,
  HeaderFooter,
  Watermark,
} from "../../types/document";
import { serializeBlockSdt } from "./blockSdtSerializer";
import { serializeParagraph } from "./paragraphSerializer";
import { serializeTable } from "./tableSerializer";
import { escapeXml } from "./xmlUtils";

// Namespaces declared on the header/footer root. Mirrors the document
// serializer's declared set so any raw replay path (`rawPropertiesXml`,
// unmodeled OOXML extensions inside a captured SDT) lands on a root that
// declares every standard prefix it might use.
const NAMESPACES: Record<string, string> = {
  wpc: "http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas",
  mc: "http://schemas.openxmlformats.org/markup-compatibility/2006",
  o: "urn:schemas-microsoft-com:office:office",
  r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  m: "http://schemas.openxmlformats.org/officeDocument/2006/math",
  v: "urn:schemas-microsoft-com:vml",
  // DrawingML core + picture. Required for raw-replay of DrawingML
  // watermarks captured by `parseWatermark`: `rawWatermarkXml` carries
  // `<a:graphic>` / `<a:txBody>` / `<pic:pic>` descendants, but the
  // hosting paragraph alone doesn't preserve the original header's
  // ancestor namespace declarations.
  a: "http://schemas.openxmlformats.org/drawingml/2006/main",
  pic: "http://schemas.openxmlformats.org/drawingml/2006/picture",
  wp14: "http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing",
  wp: "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
  w10: "urn:schemas-microsoft-com:office:word",
  w: "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  w14: "http://schemas.microsoft.com/office/word/2010/wordml",
  w15: "http://schemas.microsoft.com/office/word/2012/wordml",
  w16: "http://schemas.microsoft.com/office/word/2018/wordml",
  w16cex: "http://schemas.microsoft.com/office/word/2018/wordml/cex",
  w16cid: "http://schemas.microsoft.com/office/word/2016/wordml/cid",
  w16sdtdh: "http://schemas.microsoft.com/office/word/2020/wordml/sdtdatahash",
  w16se: "http://schemas.microsoft.com/office/word/2015/wordml/symex",
  wpg: "http://schemas.microsoft.com/office/word/2010/wordprocessingGroup",
  wps: "http://schemas.microsoft.com/office/word/2010/wordprocessingShape",
};

function buildNamespaceDeclarations(): string {
  return Object.entries(NAMESPACES)
    .map(([prefix, uri]) => `xmlns:${prefix}="${uri}"`)
    .join(" ");
}

/**
 * Serialize a block content item (paragraph, table, or block-level SDT) for
 * header/footer.
 */
function serializeBlock(block: BlockContent): string {
  if (block.type === "paragraph") {
    return serializeParagraph(block);
  }
  if (block.type === "table") {
    return serializeTable(block);
  }
  return serializeBlockSdt(block, serializeBlock);
}

/**
 * Serialize a HeaderFooter object to valid OOXML XML
 *
 * @param hf - HeaderFooter object to serialize
 * @returns Complete XML string for header*.xml or footer*.xml
 */
export function serializeHeaderFooter(hf: HeaderFooter): string {
  const rootTag = hf.type === "header" ? "w:hdr" : "w:ftr";
  const nsDecl = buildNamespaceDeclarations();

  // Watermark replay. The parser captured the hosting paragraph's
  // verbatim XML (`rawWatermarkXml`) and detached it from `content`,
  // so emit it back as the first child of the header element. If a
  // caller mutated `hf.watermark` without updating the raw XML (e.g.
  // a future setDocumentWatermark path), the model-driven synthesizer
  // takes over and emits a freshly-built VML watermark paragraph.
  const watermarkXml = serializeWatermarkParagraph(hf);

  // Serialize content blocks
  let contentXml = hf.content.map((block) => serializeBlock(block)).join("");

  // Ensure at least one empty paragraph (required by OOXML spec)
  if (!watermarkXml && !contentXml) {
    contentXml = "<w:p><w:pPr/></w:p>";
  }

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<${rootTag} ${nsDecl}>${watermarkXml}${contentXml}</${rootTag}>`;
}

function serializeWatermarkParagraph(hf: HeaderFooter): string {
  if (hf.rawWatermarkXml) {
    return hf.rawWatermarkXml;
  }
  if (hf.watermark) {
    return synthesizeWatermarkParagraph(hf.watermark);
  }
  return "";
}

function synthesizeWatermarkParagraph(watermark: Watermark): string {
  if (watermark.kind === "text") {
    return synthesizeTextWatermark(watermark);
  }
  return synthesizePictureWatermark(watermark);
}

function synthesizeTextWatermark(
  watermark: Extract<Watermark, { kind: "text" }>,
): string {
  // VML shape values mirror what Word's "Insert → Watermark" UI emits.
  // The shapetype id 136 is the WordArt template the model is anchored
  // on (gating in the parser); the size and offset numbers come from
  // Word's default text-watermark layout. Sufficient for round-trip
  // when the caller programmatically built the watermark; a parsed-
  // then-saved DOCX takes the raw replay path above.
  const rotation = watermark.diagonal === false ? 0 : 315;
  const fillcolor = watermark.color ? `#${watermark.color}` : "#C0C0C0";
  const fontFamily = watermark.font ?? "Calibri";
  const text = escapeXml(watermark.text);
  return (
    `<w:p><w:r><w:pict>` +
    `<v:shape id="PowerPlusWaterMarkObject1" type="#_x0000_t136" ` +
    `style="position:absolute;margin-left:0;margin-top:0;width:415pt;height:207pt;rotation:${rotation};z-index:-251658240;mso-position-horizontal:center;mso-position-horizontal-relative:margin;mso-position-vertical:center;mso-position-vertical-relative:margin" ` +
    `fillcolor="${fillcolor}" stroked="f">` +
    `<v:textpath style="font-family:&quot;${escapeXml(fontFamily)}&quot;;font-size:1pt" string="${text}"/>` +
    `</v:shape></w:pict></w:r></w:p>`
  );
}

function synthesizePictureWatermark(
  watermark: Extract<Watermark, { kind: "picture" }>,
): string {
  // Same VML shapetype convention as Word's UI: shape id begins with
  // `WordPictureWatermark` so a future round-trip parses cleanly via
  // the id-prefix guard.
  const rId = escapeXml(watermark.imageRId);
  return (
    `<w:p><w:r><w:pict>` +
    `<v:shape id="WordPictureWatermark1" type="#_x0000_t75" ` +
    `style="position:absolute;margin-left:0;margin-top:0;width:415pt;height:207pt;z-index:-251658240;mso-position-horizontal:center;mso-position-horizontal-relative:margin;mso-position-vertical:center;mso-position-vertical-relative:margin">` +
    `<v:imagedata r:id="${rId}" o:title=""/>` +
    `</v:shape></w:pict></w:r></w:p>`
  );
}
