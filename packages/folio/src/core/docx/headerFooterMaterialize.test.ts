/**
 * Header/footer part materialization on save.
 *
 * A header/footer created in memory (by the header editor, or by watermark
 * coverage) is keyed in `package.headers`/`footers` by an rId that has no
 * relationship in `word/_rels/document.xml.rels` yet. Without materialization
 * the full-repack path silently drops it (`collectHeaderFooterUpdates` skips
 * any rId it can't resolve) and the selective fast-path can't register the new
 * part either. Materialization promotes such an entry to a real part:
 * `word/headerN.xml` + a document relationship under its rId + a
 * `[Content_Types].xml` Override. Selective save must bail so the full-repack
 * path handles it. Prerequisite for watermark header coverage
 * (eigenpal/docx-editor#684) and a standalone fix for the editor's
 * add-header flow.
 */
import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import type { HeaderFooter } from "../types/document";
import { parseDocx } from "./parser";
import {
  createEmptyDocx,
  hasUnmaterializedHeaderFooter,
  repackDocx,
  validateDocx,
} from "./rezip";
import { attemptSelectiveSave } from "./selectiveSave";

const firstPageHeader: HeaderFooter = {
  type: "header",
  hdrFtrType: "first",
  content: [
    {
      type: "paragraph",
      content: [
        { type: "run", content: [{ type: "text", text: "TOP SECRET" }] },
      ],
    },
  ],
};

describe("header/footer part materialization on save", () => {
  test("writes the part, relationship, and Content_Types override for an in-memory header", async () => {
    const base = await createEmptyDocx();
    const doc = await parseDocx(base, { preloadFonts: false });

    const synthRId = "rId_new_first";
    doc.package.headers = new Map([[synthRId, firstPageHeader]]);
    doc.package.document.finalSectionProperties = {
      ...doc.package.document.finalSectionProperties,
      titlePg: true,
      headerReferences: [{ type: "first", rId: synthRId }],
    };

    const out = await repackDocx(doc, { updateModifiedDate: false });

    expect((await validateDocx(out)).valid).toBe(true);

    const zip = await JSZip.loadAsync(out);
    const headerFiles = Object.keys(zip.files).filter((p) =>
      /^word\/header\d+\.xml$/u.test(p),
    );
    expect(headerFiles).toHaveLength(1);
    const headerPath = headerFiles[0]!;
    expect(await zip.file(headerPath)!.async("text")).toContain("TOP SECRET");

    const target = headerPath.replace(/^word\//u, "");
    const rels = await zip.file("word/_rels/document.xml.rels")!.async("text");
    expect(rels).toContain(`Id="${synthRId}"`);
    expect(rels).toContain(`Target="${target}"`);

    expect(await zip.file("[Content_Types].xml")!.async("text")).toContain(
      `PartName="/${headerPath}"`,
    );

    // The materialized header survives a full re-parse.
    const reparsed = await parseDocx(out, { preloadFonts: false });
    expect(reparsed.package.headers?.size).toBe(1);
  });

  test("does not re-materialize an already-resolvable parsed header", async () => {
    const base = await createEmptyDocx();
    const doc = await parseDocx(base, { preloadFonts: false });
    expect(hasUnmaterializedHeaderFooter(doc)).toBe(false);

    doc.package.headers = new Map([["rId_new_x", { ...firstPageHeader }]]);
    expect(hasUnmaterializedHeaderFooter(doc)).toBe(true);
  });

  test("selective save bails to full repack when a header is unmaterialized", async () => {
    const base = await createEmptyDocx();
    const doc = await parseDocx(base, { preloadFonts: false });
    doc.package.headers = new Map([
      ["rId_new_default", { ...firstPageHeader }],
    ]);

    const result = await attemptSelectiveSave(doc, base, {
      changedParaIds: new Set(),
      structuralChange: false,
      hasUntrackedChanges: false,
    });
    expect(result).toBeNull();
  });
});
