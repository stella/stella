/**
 * Picture-watermark aspect-ratio fidelity.
 *
 * A picture watermark parsed from a non-2:1 source carries its real
 * width/height (in points) from the VML shape style. The synthesis path must
 * re-emit those exact dimensions instead of Word's default 415x207 box;
 * otherwise re-applying the watermark — which clears `rawWatermarkXml` and so
 * forces synthesis (e.g. `setDocumentWatermark` or cross-header propagation) —
 * stretches a non-2:1 image to 2:1 when the file is opened in Word.
 *
 * eigenpal/docx-editor#684 (OOXML watermark fidelity), adapted to folio's
 * pt-based VML pipeline (folio carries explicit width/height, not EMUs).
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

const pictureWatermarkHeader = (style: string): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr ${NS}>
  <w:p><w:r><w:pict>
    <v:shape id="WordPictureWatermark1" type="#_x0000_t75" style="${style}">
      <v:imagedata r:id="rId7" o:title=""/>
    </v:shape>
  </w:pict></w:r></w:p>
</w:hdr>`;

const pictureHeaderFooter = (
  watermark: Extract<
    NonNullable<HeaderFooter["watermark"]>,
    { kind: "picture" }
  >,
): HeaderFooter => ({
  type: "header",
  hdrFtrType: "default",
  content: [],
  watermark,
});

describe("picture watermark aspect ratio (eigenpal #684)", () => {
  test("parser captures real width/height (pt) from the VML shape style", () => {
    const header = parseHeader(
      pictureWatermarkHeader(
        "position:absolute;margin-left:0;margin-top:0;width:300pt;height:400pt",
      ),
    );
    expect(header.watermark?.kind).toBe("picture");
    if (header.watermark?.kind !== "picture") {
      return;
    }
    expect(header.watermark.widthPt).toBe(300);
    expect(header.watermark.heightPt).toBe(400);
  });

  test("synthesis emits the modeled width/height instead of the default box", () => {
    const out = serializeHeaderFooter(
      pictureHeaderFooter({
        kind: "picture",
        imageRId: "rId1",
        widthPt: 300,
        heightPt: 400,
      }),
    );
    expect(out).toContain("width:300pt");
    expect(out).toContain("height:400pt");
    expect(out).not.toContain("width:415pt");
    expect(out).not.toContain("height:207pt");
  });

  test("falls back to the default 415x207 box when no dimensions are modeled", () => {
    const out = serializeHeaderFooter(
      pictureHeaderFooter({ kind: "picture", imageRId: "rId1" }),
    );
    expect(out).toContain("width:415pt");
    expect(out).toContain("height:207pt");
  });

  test("round-trips a non-2:1 watermark's dimensions through synthesis", () => {
    // Real-world failure mode: a parsed watermark whose source is far from
    // 2:1. Re-applying it clears rawWatermarkXml, so the serializer must
    // synthesize the *parsed* dimensions, not Word's default box.
    const header = parseHeader(
      pictureWatermarkHeader(
        "position:absolute;margin-left:0;margin-top:0;width:200pt;height:500pt",
      ),
    );
    expect(header.watermark?.kind).toBe("picture");
    if (header.watermark?.kind !== "picture") {
      return;
    }
    const out = serializeHeaderFooter(pictureHeaderFooter(header.watermark));
    expect(out).toContain("width:200pt");
    expect(out).toContain("height:500pt");
    expect(out).not.toContain("width:415pt");
  });
});
