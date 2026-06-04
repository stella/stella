/**
 * Per-header picture-watermark relationship rebinding.
 *
 * A picture watermark's `imageRId` is local to each header part's own rels.
 * Propagating one watermark across headers (setDocumentWatermark) or onto a
 * coverage-created header leaves sibling headers referencing an rId that does
 * not resolve in their rels, producing a broken `<v:imagedata r:id>`. The
 * save-time rebind pass gives each header a relationship to the shared media in
 * its own rels (reusing or minting), without duplicating the image bytes.
 *
 * eigenpal/docx-editor#684 (OOXML watermark fidelity), BUG1.
 */
import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import { getDocumentWatermark, setDocumentWatermark } from "../watermark";
import { parseDocx } from "./parser";
import { RELATIONSHIP_TYPES } from "./relsParser";
import { repackDocx, validateDocx } from "./rezip";

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

// A two-header DOCX whose picture watermark lives only in header1's rels.
async function twoHeaderPictureWatermarkDocx(): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `${XML}
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
  <Override PartName="/word/header2.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
</Types>`,
  );
  zip.file(
    "_rels/.rels",
    `${XML}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="${RELATIONSHIP_TYPES.officeDocument}" Target="word/document.xml"/>
</Relationships>`,
  );
  zip.file(
    "word/_rels/document.xml.rels",
    `${XML}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId10" Type="${RELATIONSHIP_TYPES.header}" Target="header1.xml"/>
  <Relationship Id="rId11" Type="${RELATIONSHIP_TYPES.header}" Target="header2.xml"/>
</Relationships>`,
  );
  zip.file(
    "word/document.xml",
    `${XML}
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    <w:p><w:r><w:t>body</w:t></w:r></w:p>
    <w:sectPr>
      <w:headerReference w:type="default" r:id="rId10"/>
      <w:headerReference w:type="even" r:id="rId11"/>
      <w:pgSz w:w="12240" w:h="15840"/>
    </w:sectPr>
  </w:body>
</w:document>`,
  );
  // header1 owns the picture watermark and the image relationship.
  zip.file(
    "word/header1.xml",
    `${XML}
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:p><w:r><w:pict><v:shape id="WordPictureWatermark1" type="#_x0000_t75" style="position:absolute;width:300pt;height:400pt"><v:imagedata r:id="rIdImg" o:title=""/></v:shape></w:pict></w:r></w:p>
</w:hdr>`,
  );
  zip.file(
    "word/_rels/header1.xml.rels",
    `${XML}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdImg" Type="${RELATIONSHIP_TYPES.image}" Target="media/image1.png"/>
</Relationships>`,
  );
  zip.file(
    "word/header2.xml",
    `${XML}
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>even</w:t></w:r></w:p></w:hdr>`,
  );
  zip.file("word/media/image1.png", ONE_PIXEL_PNG_BASE64, { base64: true });
  zip.file(
    "word/styles.xml",
    `${XML}
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"></w:styles>`,
  );
  return zip.generateAsync({ type: "arraybuffer" });
}

const countMediaImages = async (zip: JSZip): Promise<number> =>
  Object.keys(zip.files).filter((p) => /^word\/media\/image/u.test(p)).length;

describe("picture watermark relationship rebinding (eigenpal #684)", () => {
  test("setDocumentWatermark spans multiple headers without throwing and clones per header", async () => {
    const doc = await parseDocx(await twoHeaderPictureWatermarkDocx(), {
      preloadFonts: false,
    });
    expect(doc.package.headers?.size).toBe(2);

    const next = setDocumentWatermark(doc, {
      kind: "picture",
      imageRId: "rIdImg",
    });

    const headers = [...(next.package.headers?.values() ?? [])];
    expect(headers).toHaveLength(2);
    expect(headers.every((h) => h.watermark?.kind === "picture")).toBe(true);
    // Distinct objects so per-header rId rebinding cannot leak across headers.
    expect(headers[0]!.watermark).not.toBe(headers[1]!.watermark);
  });

  test("repack rebinds the sibling header's image rId to the shared media", async () => {
    const original = await twoHeaderPictureWatermarkDocx();
    const doc = await parseDocx(original, { preloadFonts: false });

    const watermark = getDocumentWatermark(doc);
    expect(watermark?.kind).toBe("picture");

    // Propagate the picture watermark to every header part.
    const withWatermark = setDocumentWatermark(doc, watermark);
    const out = await repackDocx(withWatermark, { updateModifiedDate: false });

    expect((await validateDocx(out)).valid).toBe(true);

    const zip = await JSZip.loadAsync(out);
    // No duplicate media: both headers share the single image part.
    expect(await countMediaImages(zip)).toBe(1);

    const header2Rels = await zip
      .file("word/_rels/header2.xml.rels")!
      .async("text");
    expect(header2Rels).toContain('Target="media/image1.png"');

    // header2's imagedata rId must resolve in header2's own rels.
    const header2Xml = await zip.file("word/header2.xml")!.async("text");
    const usedRId = /<v:imagedata[^>]*\br:id="([^"]+)"/u.exec(header2Xml)?.[1];
    expect(usedRId).toBeDefined();
    expect(header2Rels).toContain(`Id="${usedRId}"`);
  });
});
