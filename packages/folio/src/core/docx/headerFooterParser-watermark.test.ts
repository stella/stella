/**
 * Watermark recovery from header parts. Word emits a behind-content
 * watermark inside one or more header parts as either:
 *
 * - VML WordArt (`<v:shape type="#_x0000_t136"><v:textpath string="…"/></v:shape>`)
 *   for text watermarks — the de-facto interchange shape.
 * - VML picture (`<v:shape><v:imagedata r:id="…"/></v:shape>`) for picture
 *   watermarks.
 * - DrawingML behind-content shape (`<w:drawing><wp:anchor behindDoc="1">…`)
 *   in newer producers. Upstream eigenpal/docx-editor#679 covers only VML;
 *   folio also detects DrawingML so templates from modern Word builds and
 *   from libraries like Aspose round-trip without dropping the watermark.
 */

import { describe, expect, test } from "bun:test";

import { parseHeader } from "./headerFooterParser";

const NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"' +
  ' xmlns:v="urn:schemas-microsoft-com:vml"' +
  ' xmlns:o="urn:schemas-microsoft-com:office:office"' +
  ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

describe("parseHeader watermark detection", () => {
  test("recovers a VML text watermark with the diagonal default", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr ${NS}>
  <w:p>
    <w:r>
      <w:pict>
        <v:shape id="PowerPlusWaterMarkObject1" type="#_x0000_t136"
                 style="position:absolute;margin-left:0;margin-top:0;width:415pt;height:207pt;rotation:315"
                 fillcolor="#C0C0C0" stroked="f">
          <v:textpath style="font-family:'Calibri';font-size:1pt" string="CONFIDENTIAL"/>
        </v:shape>
      </w:pict>
    </w:r>
  </w:p>
</w:hdr>`;
    const header = parseHeader(xml);
    expect(header.watermark).toBeDefined();
    if (!header.watermark || header.watermark.kind !== "text") {
      throw new TypeError("expected text watermark");
    }
    expect(header.watermark.text).toBe("CONFIDENTIAL");
    expect(header.watermark.font).toBe("Calibri");
    expect(header.watermark.color).toBe("C0C0C0");
    // rotation:315 is Word's encoding for -45° → diagonal.
    expect(header.watermark.diagonal).toBe(true);
  });

  test("recovers a horizontal VML text watermark (rotation 0)", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr ${NS}>
  <w:p>
    <w:r>
      <w:pict>
        <v:shape type="#_x0000_t136" style="rotation:0" fillcolor="#FF0000">
          <v:textpath style="font-family:'Arial'" string="DRAFT"/>
        </v:shape>
      </w:pict>
    </w:r>
  </w:p>
</w:hdr>`;
    const header = parseHeader(xml);
    if (!header.watermark || header.watermark.kind !== "text") {
      throw new TypeError("expected text watermark");
    }
    expect(header.watermark.text).toBe("DRAFT");
    expect(header.watermark.font).toBe("Arial");
    expect(header.watermark.color).toBe("FF0000");
    expect(header.watermark.diagonal).toBe(false);
  });

  test("recovers a VML picture watermark with the image relationship id", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr ${NS}>
  <w:p>
    <w:r>
      <w:pict>
        <v:shape id="WordPictureWatermark1" type="#_x0000_t75" style="position:absolute">
          <v:imagedata r:id="rId7" o:title="logo"/>
        </v:shape>
      </w:pict>
    </w:r>
  </w:p>
</w:hdr>`;
    const header = parseHeader(xml);
    if (!header.watermark || header.watermark.kind !== "picture") {
      throw new TypeError("expected picture watermark");
    }
    expect(header.watermark.imageRId).toBe("rId7");
  });

  test("recovers a DrawingML behind-content text watermark (modern producers)", () => {
    // Folio improvement over upstream: detect DrawingML watermarks too,
    // which modern Office / Aspose / some Polish legal templates emit.
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr ${NS}
  xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <w:p>
    <w:r>
      <w:drawing>
        <wp:anchor behindDoc="1" allowOverlap="1" simplePos="0" locked="0" layoutInCell="1" relativeHeight="0">
          <a:graphic>
            <a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">
              <a:txBody>
                <a:bodyPr/>
                <a:p>
                  <a:r>
                    <a:rPr><a:latin typeface="Calibri"/></a:rPr>
                    <a:t>CONFIDENTIAL</a:t>
                  </a:r>
                </a:p>
              </a:txBody>
            </a:graphicData>
          </a:graphic>
        </wp:anchor>
      </w:drawing>
    </w:r>
  </w:p>
</w:hdr>`;
    const header = parseHeader(xml);
    if (!header.watermark || header.watermark.kind !== "text") {
      throw new TypeError("expected text watermark");
    }
    expect(header.watermark.text).toBe("CONFIDENTIAL");
    expect(header.watermark.font).toBe("Calibri");
  });

  test("returns watermark: undefined when header has no watermark shape", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr ${NS}>
  <w:p><w:r><w:t>Page header text</w:t></w:r></w:p>
</w:hdr>`;
    const header = parseHeader(xml);
    expect(header.watermark).toBeUndefined();
  });
});
