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
    // Default Word dimensions emitted unchanged.
    expect(out).toContain("width:415pt");
    expect(out).toContain("height:207pt");
  });

  test("applies the modeled scale factor to the synthesized picture watermark", () => {
    // Model `scale` is a multiplicative factor; 0.5 → half-size on
    // both axes (the painter does the same multiplication for CSS).
    const hf: HeaderFooter = {
      type: "header",
      hdrFtrType: "default",
      content: [],
      watermark: { kind: "picture", imageRId: "rId1", scale: 0.5 },
    };
    const out = serializeHeaderFooter(hf);
    expect(out).toContain("width:207.5pt");
    expect(out).toContain("height:103.5pt");
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

  test("emits the synthesized watermark at the recorded block index", () => {
    // Caller built a watermark and told the serializer to place it
    // after the first content block. Useful when programmatically
    // mutating a watermark that was parsed at a non-zero block index.
    const hf: HeaderFooter = {
      type: "header",
      hdrFtrType: "default",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "run", content: [{ type: "text", text: "preceding" }] },
          ],
        },
        {
          type: "paragraph",
          content: [
            { type: "run", content: [{ type: "text", text: "following" }] },
          ],
        },
      ],
      watermark: { kind: "text", text: "DRAFT" },
      watermarkBlockIndex: 1,
    };
    const out = serializeHeaderFooter(hf);
    const precedingPos = out.indexOf("preceding");
    const watermarkPos = out.indexOf('string="DRAFT"');
    const followingPos = out.indexOf("following");
    expect(precedingPos).toBeGreaterThan(-1);
    expect(watermarkPos).toBeGreaterThan(precedingPos);
    expect(followingPos).toBeGreaterThan(watermarkPos);
  });

  test("emits opacity on the synthesized text watermark when set in the model", () => {
    const hf: HeaderFooter = {
      type: "header",
      hdrFtrType: "default",
      content: [],
      watermark: { kind: "text", text: "DRAFT", opacity: 0.25 },
    };
    const out = serializeHeaderFooter(hf);
    expect(out).toContain('<v:fill opacity="0.25"/>');
  });

  test("omits opacity on the synthesized text watermark when undefined", () => {
    // The default Word transparency falls out of the renderer + Word's
    // own UI when no explicit opacity is present.
    const hf: HeaderFooter = {
      type: "header",
      hdrFtrType: "default",
      content: [],
      watermark: { kind: "text", text: "DRAFT" },
    };
    const out = serializeHeaderFooter(hf);
    expect(out).not.toContain("<v:fill");
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
