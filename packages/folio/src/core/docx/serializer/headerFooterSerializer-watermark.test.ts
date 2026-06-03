/**
 * Watermark emission on header serialize. Two paths covered:
 *
 * - Raw replay — `parseHeader` captured `rawWatermarkXml` for parsed
 *   DOCXs, so a round-trip without mutation preserves the watermark
 *   byte-exact.
 * - Synthesis — a `HeaderFooter` constructed programmatically (e.g. by
 *   a future `setDocumentWatermark` API) emits a fresh VML paragraph
 *   matching what Word writes.
 */

import { describe, expect, test } from "bun:test";

import type { HeaderFooter } from "../../types/document";
import { parseHeader } from "../headerFooterParser";
import { serializeHeaderFooter } from "./headerFooterSerializer";

const NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"' +
  ' xmlns:v="urn:schemas-microsoft-com:vml"' +
  ' xmlns:o="urn:schemas-microsoft-com:office:office"' +
  ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

describe("serializeHeaderFooter — watermark replay", () => {
  test("round-trips a parsed VML text watermark verbatim", () => {
    const sourceXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr ${NS}>
  <w:p>
    <w:r>
      <w:pict>
        <v:shape id="PowerPlusWaterMarkObject1" type="#_x0000_t136" style="rotation:315" fillcolor="#C0C0C0">
          <v:textpath style="font-family:'Calibri'" string="CONFIDENTIAL"/>
        </v:shape>
      </w:pict>
    </w:r>
  </w:p>
  <w:p><w:r><w:t>regular header text</w:t></w:r></w:p>
</w:hdr>`;
    const header = parseHeader(sourceXml);
    const out = serializeHeaderFooter(header);
    expect(out).toContain("v:shape");
    expect(out).toContain('type="#_x0000_t136"');
    expect(out).toContain('string="CONFIDENTIAL"');
    expect(out).toContain("rotation:315");
    // Regular header content survives too.
    expect(out).toContain("regular header text");
  });

  test("emits a synthesized VML text watermark when only the model is set", () => {
    const hf: HeaderFooter = {
      type: "header",
      hdrFtrType: "default",
      content: [],
      watermark: {
        kind: "text",
        text: "DRAFT",
        font: "Arial",
        color: "FF0000",
        diagonal: false,
      },
    };
    const out = serializeHeaderFooter(hf);
    expect(out).toContain('type="#_x0000_t136"');
    expect(out).toContain('string="DRAFT"');
    expect(out).toContain('fillcolor="#FF0000"');
    expect(out).toContain("font-family:&quot;Arial&quot;");
    expect(out).toContain("rotation:0");
    expect(out).toContain('id="PowerPlusWaterMarkObject');
  });

  test("emits a synthesized VML picture watermark by relationship id", () => {
    const hf: HeaderFooter = {
      type: "header",
      hdrFtrType: "default",
      content: [],
      watermark: {
        kind: "picture",
        imageRId: "rId42",
      },
    };
    const out = serializeHeaderFooter(hf);
    expect(out).toContain('type="#_x0000_t75"');
    expect(out).toContain('r:id="rId42"');
    expect(out).toContain('id="WordPictureWatermark');
  });

  test("escapes XML metacharacters in the synthesized text watermark string", () => {
    const hf: HeaderFooter = {
      type: "header",
      hdrFtrType: "default",
      content: [],
      watermark: {
        kind: "text",
        text: 'A & B "draft" <internal>',
      },
    };
    const out = serializeHeaderFooter(hf);
    expect(out).toContain(
      'string="A &amp; B &quot;draft&quot; &lt;internal&gt;"',
    );
  });

  test('maps documented color:"auto" to the silver default fillcolor', () => {
    const hf: HeaderFooter = {
      type: "header",
      hdrFtrType: "default",
      content: [],
      watermark: { kind: "text", text: "X", color: "auto" },
    };
    const out = serializeHeaderFooter(hf);
    // Not `fillcolor="#auto"` (invalid VML) — fall back to silver.
    expect(out).toContain('fillcolor="#C0C0C0"');
    expect(out).not.toContain('fillcolor="#auto"');
  });

  test("emits no watermark element when the header carries none", () => {
    const hf: HeaderFooter = {
      type: "header",
      hdrFtrType: "default",
      content: [],
    };
    const out = serializeHeaderFooter(hf);
    expect(out).not.toContain("v:shape");
    expect(out).not.toContain("v:textpath");
    // Header still meets the minimum non-empty body requirement.
    expect(out).toContain("<w:p");
  });

  test("does not duplicate the watermark paragraph in the regular content stream", () => {
    // Regression for the parser-side filtering: the watermark paragraph
    // is detached from `content` so it isn't emitted twice.
    const sourceXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr ${NS}>
  <w:p>
    <w:r>
      <w:pict>
        <v:shape id="PowerPlusWaterMarkObject1" type="#_x0000_t136" style="rotation:315">
          <v:textpath string="CONFIDENTIAL"/>
        </v:shape>
      </w:pict>
    </w:r>
  </w:p>
</w:hdr>`;
    const header = parseHeader(sourceXml);
    const out = serializeHeaderFooter(header);
    // Watermark shape appears exactly once.
    expect(out.match(/<v:shape/gu)?.length).toBe(1);
    expect(out.match(/string="CONFIDENTIAL"/gu)?.length).toBe(1);
  });
});
