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

  test("a header logo VML imagedata is not promoted to a picture watermark", () => {
    // Logo images dropped into a header from the Word ribbon get a
    // plain `_x0000_sNNN` shape id, not `WordPictureWatermark…`.
    // Without the id check, every such logo would round-trip as a
    // full-page behind-content image on save.
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr ${NS}>
  <w:p>
    <w:r>
      <w:pict>
        <v:shape id="_x0000_s1025" style="position:absolute" type="#_x0000_t75">
          <v:imagedata r:id="rId7" o:title="company-logo"/>
        </v:shape>
      </w:pict>
    </w:r>
  </w:p>
</w:hdr>`;
    const header = parseHeader(xml);
    expect(header.watermark).toBeUndefined();
  });

  test("a header logo does not shadow a later real text watermark", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr ${NS}>
  <w:p>
    <w:r>
      <w:pict>
        <v:shape id="_x0000_s1025" type="#_x0000_t75">
          <v:imagedata r:id="rId7"/>
        </v:shape>
      </w:pict>
    </w:r>
  </w:p>
  <w:p>
    <w:r>
      <w:pict>
        <v:shape id="PowerPlusWaterMarkObject1" type="#_x0000_t136" style="rotation:315" fillcolor="#C0C0C0">
          <v:textpath style="font-family:'Calibri'" string="CONFIDENTIAL"/>
        </v:shape>
      </w:pict>
    </w:r>
  </w:p>
</w:hdr>`;
    const header = parseHeader(xml);
    if (!header.watermark || header.watermark.kind !== "text") {
      throw new TypeError("expected text watermark, logo should not shadow");
    }
    expect(header.watermark.text).toBe("CONFIDENTIAL");
  });

  test("a header background DrawingML anchor does not shadow a later real watermark", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr ${NS}
  xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <w:p>
    <w:r>
      <w:drawing>
        <wp:anchor behindDoc="1">
          <a:graphic><a:graphicData/></a:graphic>
        </wp:anchor>
      </w:drawing>
    </w:r>
  </w:p>
  <w:p>
    <w:r>
      <w:drawing>
        <wp:anchor behindDoc="1">
          <a:graphic>
            <a:graphicData>
              <a:txBody>
                <a:p><a:r><a:t>CONFIDENTIAL</a:t></a:r></a:p>
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
      throw new TypeError(
        "expected text watermark, background should not shadow",
      );
    }
    expect(header.watermark.text).toBe("CONFIDENTIAL");
  });

  test("extracts the primary font from a comma-separated family list", () => {
    // Word sometimes emits `font-family:'Calibri','sans-serif'`. The
    // previous stripQuotes implementation saw matching `'` at both
    // ends of the whole string and returned `Calibri','sans-serif`.
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr ${NS}>
  <w:p>
    <w:r>
      <w:pict>
        <v:shape id="PowerPlusWaterMarkObject1" type="#_x0000_t136" style="rotation:315">
          <v:textpath style="font-family:'Calibri','sans-serif'" string="DRAFT"/>
        </v:shape>
      </w:pict>
    </w:r>
  </w:p>
</w:hdr>`;
    const header = parseHeader(xml);
    if (!header.watermark || header.watermark.kind !== "text") {
      throw new TypeError("expected text watermark");
    }
    expect(header.watermark.font).toBe("Calibri");
  });

  test("tolerates whitespace around the colon in inline styles", () => {
    // Hand-authored DOCX templates and some legacy tools emit
    // `key : value` instead of `key:value`. Previously parseInlineStyle
    // matched the literal prefix `"rotation:"` and missed the spaced form.
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr ${NS}>
  <w:p>
    <w:r>
      <w:pict>
        <v:shape id="PowerPlusWaterMarkObject1" type="#_x0000_t136"
                 style="rotation : 315">
          <v:textpath style="font-family : Calibri" string="DRAFT"/>
        </v:shape>
      </w:pict>
    </w:r>
  </w:p>
</w:hdr>`;
    const header = parseHeader(xml);
    if (!header.watermark || header.watermark.kind !== "text") {
      throw new TypeError("expected text watermark");
    }
    expect(header.watermark.diagonal).toBe(true);
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

  test("preserves the documented lowercase 'auto' fillcolor sentinel", () => {
    // The renderer/serializer special-case the exact lowercase value
    // when mapping back to Word's silver default; uppercasing "AUTO"
    // would round-trip as the invalid CSS color `#AUTO`.
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr ${NS}>
  <w:p>
    <w:r>
      <w:pict>
        <v:shape id="PowerPlusWaterMarkObject1" type="#_x0000_t136" fillcolor="auto">
          <v:textpath string="DRAFT"/>
        </v:shape>
      </w:pict>
    </w:r>
  </w:p>
</w:hdr>`;
    const header = parseHeader(xml);
    if (!header.watermark || header.watermark.kind !== "text") {
      throw new TypeError("expected text watermark");
    }
    expect(header.watermark.color).toBe("auto");
  });

  test("recovers a DrawingML watermark when behindDoc is the xsd:boolean 'true'", () => {
    // ECMA-376 allows the xsd:boolean serializations `"1"` (Word's
    // default) and `"true"` (equally valid). Producers in the wild
    // emit both — refusing the textual form would silently drop the
    // watermark on save.
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr ${NS} xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <w:p>
    <w:r>
      <w:drawing>
        <wp:anchor behindDoc="true">
          <a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">
            <a:txBody><a:p><a:r><a:t>CONFIDENTIAL</a:t></a:r></a:p></a:txBody>
          </a:graphicData></a:graphic>
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
  });

  test("captures opacity from the VML fill child (decimal form)", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr ${NS}>
  <w:p>
    <w:r>
      <w:pict>
        <v:shape id="PowerPlusWaterMarkObject1" type="#_x0000_t136" fillcolor="#C0C0C0">
          <v:fill opacity=".25"/>
          <v:textpath string="DRAFT"/>
        </v:shape>
      </w:pict>
    </w:r>
  </w:p>
</w:hdr>`;
    const header = parseHeader(xml);
    if (!header.watermark || header.watermark.kind !== "text") {
      throw new TypeError("expected text watermark");
    }
    expect(header.watermark.opacity).toBe(0.25);
  });

  test("captures opacity from the VML fill child (fixed-point form)", () => {
    // Word's older form: opacity="32768f" means 32768/65536 = 0.5.
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr ${NS}>
  <w:p>
    <w:r>
      <w:pict>
        <v:shape id="PowerPlusWaterMarkObject1" type="#_x0000_t136" fillcolor="#C0C0C0">
          <v:fill opacity="32768f"/>
          <v:textpath string="DRAFT"/>
        </v:shape>
      </w:pict>
    </w:r>
  </w:p>
</w:hdr>`;
    const header = parseHeader(xml);
    if (!header.watermark || header.watermark.kind !== "text") {
      throw new TypeError("expected text watermark");
    }
    expect(header.watermark.opacity).toBe(0.5);
  });

  test("records the watermark's block index so the serializer can replay in place", () => {
    // Watermark is the second block (index 1) — a visible paragraph
    // precedes it. The parser must record `watermarkBlockIndex: 1` so
    // serialization splices the watermark after the visible block,
    // not at the top.
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr ${NS}>
  <w:p><w:r><w:t>preceding text</w:t></w:r></w:p>
  <w:p>
    <w:r>
      <w:pict>
        <v:shape id="PowerPlusWaterMarkObject1" type="#_x0000_t136">
          <v:textpath string="DRAFT"/>
        </v:shape>
      </w:pict>
    </w:r>
  </w:p>
</w:hdr>`;
    const header = parseHeader(xml);
    expect(header.watermark).toBeDefined();
    expect(header.watermarkBlockIndex).toBe(1);
  });

  test("does not detach a paragraph that mixes the watermark with sibling text", () => {
    // Surgically removing just the shape from a mixed paragraph is out
    // of scope; refuse to claim the watermark so the original paragraph
    // round-trips through the normal block parser with its text intact.
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr ${NS}>
  <w:p>
    <w:r><w:t>page header </w:t></w:r>
    <w:r>
      <w:pict>
        <v:shape id="PowerPlusWaterMarkObject1" type="#_x0000_t136">
          <v:textpath string="DRAFT"/>
        </v:shape>
      </w:pict>
    </w:r>
  </w:p>
</w:hdr>`;
    const header = parseHeader(xml);
    expect(header.watermark).toBeUndefined();
    expect(header.rawWatermarkXml).toBeUndefined();
    // Original mixed paragraph stays in content (the regular block
    // parser surfaces the sibling text run).
    expect(header.content.length).toBeGreaterThan(0);
  });
});
