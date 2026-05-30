/**
 * Tests for selective-save guard rails added to harden the rollout:
 *   - memory ceiling (originalBuffer.byteLength > maxBytes → null)
 *   - structural-change fallback
 *   - untracked-change fallback
 *   - invalid model fallback
 *   - new image / new hyperlink fallback
 *   - feature-flag resolution at the call site
 *
 * Existing selective-save behaviour (patch application, cross-reference
 * invariants, comments/headers/footers handling) is covered in
 * `selectiveSave.test.ts`. These tests focus exclusively on the new code
 * paths landed alongside the feature flag.
 */

import { describe, test, expect } from "bun:test";
import JSZip from "jszip";

import { parseDocx } from "./parser";
import { attemptSelectiveSave } from "./selectiveSave";
import {
  DEFAULT_SELECTIVE_SAVE_MAX_BYTES,
  resolveSelectiveSaveFlags,
} from "./selectiveSaveFlags";

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

const PARAGRAPH = (id: string, text: string): string =>
  `<w:p w14:paraId="${id}"><w:r><w:t>${text}</w:t></w:r></w:p>`;

const DOCUMENT_XML = `${XML_DECL}
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    ${PARAGRAPH("P0000001", "Hello world")}
    ${PARAGRAPH("P0000002", "Second paragraph")}
    <w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>
  </w:body>
</w:document>`;

const CONTENT_TYPES = `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`;

const PACKAGE_RELS = `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;

const DOC_RELS = `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;

const STYLES = `${XML_DECL}<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`;

const CORE_PROPS = `${XML_DECL}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>fx</dc:title><dcterms:modified xsi:type="dcterms:W3CDTF">2024-01-01T00:00:00.000Z</dcterms:modified></cp:coreProperties>`;

async function makeFixture(extraPaddingBytes = 0): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES);
  zip.file("_rels/.rels", PACKAGE_RELS);
  zip.file("word/_rels/document.xml.rels", DOC_RELS);
  zip.file("word/document.xml", DOCUMENT_XML);
  zip.file("word/styles.xml", STYLES);
  zip.file("docProps/core.xml", CORE_PROPS);
  if (extraPaddingBytes > 0) {
    // Synthetic large binary so we can drive the memory-threshold guard
    // without inflating the test runner with multi-MB fixtures.
    zip.file("word/media/padding.bin", new Uint8Array(extraPaddingBytes), {
      compression: "STORE",
    });
  }
  return zip.generateAsync({ type: "arraybuffer" });
}

describe("memory threshold guard", () => {
  test("allows the selective path when the buffer is under the ceiling", async () => {
    const buffer = await makeFixture();
    const doc = await parseDocx(buffer, { preloadFonts: false });

    const result = await attemptSelectiveSave(doc, buffer, {
      changedParaIds: new Set(),
      structuralChange: false,
      hasUntrackedChanges: false,
      maxBytes: buffer.byteLength + 1,
    });

    expect(result).not.toBeNull();
  });

  test("returns null when the buffer is over the configured ceiling", async () => {
    const buffer = await makeFixture();
    const doc = await parseDocx(buffer, { preloadFonts: false });

    const result = await attemptSelectiveSave(doc, buffer, {
      changedParaIds: new Set(),
      structuralChange: false,
      hasUntrackedChanges: false,
      maxBytes: buffer.byteLength - 1,
    });

    expect(result).toBeNull();
  });

  test("allows the selective path when the buffer is exactly at the ceiling", async () => {
    const buffer = await makeFixture();
    const doc = await parseDocx(buffer, { preloadFonts: false });

    // The guard refuses strictly greater than maxBytes.
    const result = await attemptSelectiveSave(doc, buffer, {
      changedParaIds: new Set(),
      structuralChange: false,
      hasUntrackedChanges: false,
      maxBytes: buffer.byteLength,
    });

    expect(result).not.toBeNull();
  });

  test("default ceiling (100 MiB) is large enough for typical legal documents", async () => {
    const buffer = await makeFixture();
    const doc = await parseDocx(buffer, { preloadFonts: false });

    const result = await attemptSelectiveSave(doc, buffer, {
      changedParaIds: new Set(),
      structuralChange: false,
      hasUntrackedChanges: false,
      // omit maxBytes → DEFAULT_SELECTIVE_SAVE_MAX_BYTES applies
    });

    expect(result).not.toBeNull();
    expect(buffer.byteLength).toBeLessThan(DEFAULT_SELECTIVE_SAVE_MAX_BYTES);
  });

  test("crosses the threshold cleanly when padding pushes the buffer over", async () => {
    const padded = await makeFixture(8 * 1024);
    const doc = await parseDocx(padded, { preloadFonts: false });

    const tooSmall = await attemptSelectiveSave(doc, padded, {
      changedParaIds: new Set(),
      structuralChange: false,
      hasUntrackedChanges: false,
      maxBytes: 4 * 1024,
    });

    const allowed = await attemptSelectiveSave(doc, padded, {
      changedParaIds: new Set(),
      structuralChange: false,
      hasUntrackedChanges: false,
      maxBytes: padded.byteLength,
    });

    expect(tooSmall).toBeNull();
    expect(allowed).not.toBeNull();
  });
});

describe("fallback contract", () => {
  test("structural change → null", async () => {
    const buffer = await makeFixture();
    const doc = await parseDocx(buffer, { preloadFonts: false });

    const result = await attemptSelectiveSave(doc, buffer, {
      changedParaIds: new Set(["P0000001"]),
      structuralChange: true,
      hasUntrackedChanges: false,
    });

    expect(result).toBeNull();
  });

  test("untracked changes → null", async () => {
    const buffer = await makeFixture();
    const doc = await parseDocx(buffer, { preloadFonts: false });

    const result = await attemptSelectiveSave(doc, buffer, {
      changedParaIds: new Set(["P0000001"]),
      structuralChange: false,
      hasUntrackedChanges: true,
    });

    expect(result).toBeNull();
  });

  test("new image (data: URL without rId) → null", async () => {
    const buffer = await makeFixture();
    const doc = await parseDocx(buffer, { preloadFonts: false });
    doc.package.document.content.unshift({
      type: "paragraph",
      content: [
        {
          type: "run",
          content: [
            {
              type: "drawing",
              wrap: { type: "inline" },
              image: {
                src: "data:image/png;base64,AAAA",
                width: 100,
                height: 100,
              },
            },
          ],
        },
      ],
    });

    const result = await attemptSelectiveSave(doc, buffer, {
      changedParaIds: new Set(),
      structuralChange: false,
      hasUntrackedChanges: false,
    });

    expect(result).toBeNull();
  });

  test("new hyperlink (href without rId / anchor) → null", async () => {
    const buffer = await makeFixture();
    const doc = await parseDocx(buffer, { preloadFonts: false });
    doc.package.document.content.unshift({
      type: "paragraph",
      content: [
        {
          type: "hyperlink",
          href: "https://example.com",
          content: [
            { type: "run", content: [{ type: "text", text: "link" }] },
          ],
        },
      ],
    });

    const result = await attemptSelectiveSave(doc, buffer, {
      changedParaIds: new Set(),
      structuralChange: false,
      hasUntrackedChanges: false,
    });

    expect(result).toBeNull();
  });

  test("invalid model → null (orphaned commentReference triggers validator)", async () => {
    const buffer = await makeFixture();
    const doc = await parseDocx(buffer, { preloadFonts: false });
    doc.package.document.content.unshift({
      type: "paragraph",
      content: [{ type: "commentReference", id: 9999 }],
    });

    const result = await attemptSelectiveSave(doc, buffer, {
      changedParaIds: new Set(),
      structuralChange: false,
      hasUntrackedChanges: false,
    });

    expect(result).toBeNull();
  });
});

describe("flag resolution at the call boundary", () => {
  test("when flags are absent, selective save is OFF", () => {
    const resolved = resolveSelectiveSaveFlags(undefined);
    expect(resolved.selectiveSave).toBe(false);
  });

  test("a host that opts in still gets the tripwire off by default", () => {
    const resolved = resolveSelectiveSaveFlags({ selectiveSave: true });
    expect(resolved.selectiveSave).toBe(true);
    expect(resolved.selectiveSaveTripwire).toBe(false);
  });

  test("a host enabling only the tripwire keeps selective save off", () => {
    const resolved = resolveSelectiveSaveFlags({
      selectiveSaveTripwire: true,
    });
    expect(resolved.selectiveSave).toBe(false);
    expect(resolved.selectiveSaveTripwire).toBe(true);
  });
});
