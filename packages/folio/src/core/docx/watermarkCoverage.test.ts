/**
 * End-to-end watermark header coverage: a title-page section without its own
 * first-page header should still show the watermark on the cover page. The
 * coverage transform creates the header in the model; the save pipeline
 * materializes it into a real part. eigenpal/docx-editor#684 (BUG2).
 */
import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import type { HeaderFooter } from "../types/document";
import { setDocumentWatermark } from "../watermark";
import { parseDocx } from "./parser";
import { createEmptyDocx, repackDocx, validateDocx } from "./rezip";

describe("watermark header coverage on save (eigenpal #684)", () => {
  test("a titlePg section without a first header gets one carrying the watermark", async () => {
    const base = await createEmptyDocx();
    const doc = await parseDocx(base, { preloadFonts: false });

    // A default header plus a title-page final section that lacks a first header.
    const defaultHeader: HeaderFooter = {
      type: "header",
      hdrFtrType: "default",
      content: [],
    };
    doc.package.headers = new Map([["rIdHdr", defaultHeader]]);
    doc.package.document.finalSectionProperties = {
      ...doc.package.document.finalSectionProperties,
      titlePg: true,
      headerReferences: [{ type: "default", rId: "rIdHdr" }],
    };

    const withWatermark = setDocumentWatermark(doc, {
      kind: "text",
      text: "CONFIDENTIAL",
    });
    const out = await repackDocx(withWatermark, { updateModifiedDate: false });

    expect((await validateDocx(out)).valid).toBe(true);

    const zip = await JSZip.loadAsync(out);
    const headerFiles = Object.keys(zip.files).filter((p) =>
      /^word\/header\d+\.xml$/u.test(p),
    );
    // Default header + the coverage-created first-page header.
    expect(headerFiles).toHaveLength(2);
    for (const path of headerFiles) {
      expect(await zip.file(path)!.async("text")).toContain("CONFIDENTIAL");
    }

    const docXml = await zip.file("word/document.xml")!.async("text");
    expect(docXml).toMatch(/<w:headerReference[^>]*w:type="first"/u);

    const reparsed = await parseDocx(out, { preloadFonts: false });
    expect(reparsed.package.headers?.size).toBe(2);
  });
});
