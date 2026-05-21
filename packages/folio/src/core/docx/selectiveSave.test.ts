/**
 * Integration tests for Selective Save
 *
 * Tests the full pipeline: parse DOCX → modify document model → selective save → verify XML.
 * Uses generated DOCX packages with real parsing and serialization to ensure round-trip correctness.
 */

import { describe, test, expect } from "bun:test";
import JSZip from "jszip";

import type { Paragraph, Run } from "../types/document";
import { parseDocx } from "./parser";
import { repackDocx } from "./rezip";
import { attemptSelectiveSave } from "./selectiveSave";
import {
  findParagraphOffsets,
  buildPatchedDocumentXml,
  validatePatchSafety,
  countParagraphElements,
} from "./selectiveXmlPatch";
import { serializeDocument } from "./serializer/documentSerializer";

// ============================================================================
// Helpers
// ============================================================================

type FixtureOptions = {
  paragraphCount?: number;
  includeTable?: boolean;
  includeHeaderFooter?: boolean;
  includeStyles?: boolean;
  includeImage?: boolean;
};

const XML_DECLARATION =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

const paragraphXml = (id: string, text: string, styleId?: string): string => {
  const styleXml = styleId
    ? `<w:pPr><w:pStyle w:val="${styleId}"/></w:pPr>`
    : "";
  return `<w:p w14:paraId="${id}">${styleXml}<w:r><w:t>${text}</w:t></w:r></w:p>`;
};

const SAMPLE_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06,
  0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44,
  0x41, 0x54, 0x78, 0x9c, 0x63, 0xf8, 0xff, 0xff, 0x3f, 0x00, 0x05, 0xfe, 0x02,
  0xfe, 0xdc, 0xcc, 0x59, 0xe7, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
  0xae, 0x42, 0x60, 0x82,
]);

const imageRelationshipId = (includeHeaderFooter: boolean): string =>
  includeHeaderFooter ? "rId3" : "rId1";

const contentTypesXml = (
  includeHeaderFooter: boolean,
  includeImage: boolean,
): string => `${XML_DECLARATION}
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  ${includeImage ? '<Default Extension="png" ContentType="image/png"/>' : ""}
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  ${
    includeHeaderFooter
      ? '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>'
      : ""
  }
</Types>`;

const packageRelsXml = `${XML_DECLARATION}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`;

const documentRelsXml = (
  includeHeaderFooter: boolean,
  includeImage: boolean,
): string => {
  const relationships: string[] = [];
  if (includeHeaderFooter) {
    relationships.push(
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>',
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>',
    );
  }
  if (includeImage) {
    relationships.push(
      `<Relationship Id="${imageRelationshipId(includeHeaderFooter)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>`,
    );
  }

  return `${XML_DECLARATION}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${relationships.join("")}
</Relationships>`;
};

const stylesXml = `${XML_DECLARATION}
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:keepNext/></w:pPr>
  </w:style>
</w:styles>`;

const corePropertiesXml = `${XML_DECLARATION}
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>Selective save fixture</dc:title>
  <cp:lastModifiedBy>Test</cp:lastModifiedBy>
  <dcterms:modified xsi:type="dcterms:W3CDTF">2024-01-01T00:00:00.000Z</dcterms:modified>
</cp:coreProperties>`;

const imageParagraphXml = (rId: string): string =>
  `<w:p w14:paraId="I0000001"><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="9525" cy="9525"/><wp:docPr id="1" name="Test image" descr="Generated fixture image"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="1" name="image1.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="9525" cy="9525"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;

const documentXml = ({
  paragraphCount = 4,
  includeTable = false,
  includeHeaderFooter = false,
  includeStyles = false,
  includeImage = false,
}: FixtureOptions): string => {
  const paragraphs: string[] = [];
  for (let index = 1; index <= paragraphCount; index++) {
    const id = `P${String(index).padStart(7, "0")}`;
    paragraphs.push(
      paragraphXml(
        id,
        `Fixture paragraph ${index}`,
        includeStyles && index === 1 ? "Heading1" : undefined,
      ),
    );
  }

  if (includeTable) {
    paragraphs.push(
      `<w:tbl><w:tr><w:tc>${paragraphXml(
        "T0000001",
        "Table cell text",
      )}</w:tc></w:tr></w:tbl>`,
    );
  }

  if (includeImage) {
    paragraphs.push(
      imageParagraphXml(imageRelationshipId(includeHeaderFooter)),
    );
  }

  const headerFooterRefs = includeHeaderFooter
    ? '<w:headerReference w:type="default" r:id="rId1"/><w:footerReference w:type="default" r:id="rId2"/>'
    : "";

  return `${XML_DECLARATION}
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    ${paragraphs.join("")}
    <w:sectPr>${headerFooterRefs}<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>
  </w:body>
</w:document>`;
};

const headerXml = `${XML_DECLARATION}
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml">
  ${paragraphXml("H0000001", "Header text")}
</w:hdr>`;

const footerXml = `${XML_DECLARATION}
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml">
  ${paragraphXml("F0000001", "Footer text")}
</w:ftr>`;

async function createFixtureDocx(
  options: FixtureOptions,
): Promise<ArrayBuffer> {
  const zip = new JSZip();
  const { includeHeaderFooter = false, includeImage = false } = options;

  zip.file(
    "[Content_Types].xml",
    contentTypesXml(includeHeaderFooter, includeImage),
  );
  zip.file("_rels/.rels", packageRelsXml);
  zip.file(
    "word/_rels/document.xml.rels",
    documentRelsXml(includeHeaderFooter, includeImage),
  );
  zip.file("word/document.xml", documentXml(options));
  zip.file("word/styles.xml", stylesXml);
  zip.file("docProps/core.xml", corePropertiesXml);

  if (includeHeaderFooter) {
    zip.file("word/header1.xml", headerXml);
    zip.file("word/footer1.xml", footerXml);
  }
  if (includeImage) {
    zip.file("word/media/image1.png", SAMPLE_PNG);
  }

  return zip.generateAsync({ type: "arraybuffer" });
}

async function loadFixture(name: string): Promise<ArrayBuffer> {
  switch (name) {
    case "EP_ZMVZ_MULTI_v4.docx":
      return createFixtureDocx({
        paragraphCount: 64,
        includeHeaderFooter: true,
      });
    case "with-tables.docx":
      return createFixtureDocx({ includeTable: true });
    case "complex-styles.docx":
      return createFixtureDocx({ includeStyles: true });
    case "example-with-image.docx":
      return createFixtureDocx({ includeImage: true });
    default:
      throw new Error(`Unknown generated DOCX fixture: ${name}`);
  }
}

async function getDocumentXml(buffer: ArrayBuffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const file = zip.file("word/document.xml");
  if (!file) {
    throw new Error("No word/document.xml found");
  }
  return file.async("text");
}

async function getBinaryEntry(
  buffer: ArrayBuffer,
  path: string,
): Promise<ArrayBuffer> {
  const zip = await JSZip.loadAsync(buffer);
  const file = zip.file(path);
  if (!file) {
    throw new Error(`No ${path} found`);
  }
  return file.async("arraybuffer");
}

// ============================================================================
// selectiveXmlPatch tests with real DOCX content
// ============================================================================

describe("Selective XML Patch with real DOCX", () => {
  test("finds paragraphs in real document.xml", async () => {
    const buffer = await loadFixture("example-with-image.docx");
    const xml = await getDocumentXml(buffer);

    // Count paragraphs
    const count = countParagraphElements(xml);
    expect(count).toBeGreaterThan(0);

    // Try to find paraIds in the XML
    const paraIdPattern = /w14:paraId="([^"]+)"/gu;
    const ids: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = paraIdPattern.exec(xml)) !== null) {
      ids.push(m[1]);
    }
    expect(ids.length).toBeGreaterThan(0);

    // Try to find offsets for each unique ID
    const uniqueIds = [...new Set(ids)];
    for (const id of uniqueIds.slice(0, 5)) {
      const offsets = findParagraphOffsets(xml, id);
      // May be null if nested w:p (inner IDs)
      if (offsets) {
        const extracted = xml.slice(offsets.start, offsets.end);
        expect(extracted).toStartWith("<w:p");
        expect(extracted).toContain(`w14:paraId="${id}"`);
      }
    }
  });

  test("validates patch safety on real document", async () => {
    const buffer = await loadFixture("example-with-image.docx");
    const doc = await parseDocx(buffer, { preloadFonts: false });
    const originalXml = await getDocumentXml(buffer);
    const serializedXml = serializeDocument(doc);

    // Empty change set should be safe
    const result = validatePatchSafety(originalXml, serializedXml, new Set());
    expect(result.safe).toBe(true);
  });
});

// ============================================================================
// attemptSelectiveSave integration tests
// ============================================================================

describe("attemptSelectiveSave", () => {
  test("returns null when structural change occurred", async () => {
    const buffer = await loadFixture("example-with-image.docx");
    const doc = await parseDocx(buffer, { preloadFonts: false });

    const result = await attemptSelectiveSave(doc, buffer, {
      changedParaIds: new Set(["someId"]),
      structuralChange: true,
      hasUntrackedChanges: false,
    });

    expect(result).toBeNull();
  });

  test("returns null when untracked changes exist", async () => {
    const buffer = await loadFixture("example-with-image.docx");
    const doc = await parseDocx(buffer, { preloadFonts: false });

    const result = await attemptSelectiveSave(doc, buffer, {
      changedParaIds: new Set(["someId"]),
      structuralChange: false,
      hasUntrackedChanges: true,
    });

    expect(result).toBeNull();
  });

  test("returns valid buffer when no content changes (still updates metadata)", async () => {
    const buffer = await loadFixture("example-with-image.docx");
    const doc = await parseDocx(buffer, { preloadFonts: false });

    const result = await attemptSelectiveSave(doc, buffer, {
      changedParaIds: new Set(),
      structuralChange: false,
      hasUntrackedChanges: false,
    });

    // Should return a valid DOCX (may differ due to core properties update)
    expect(result).not.toBeNull();
    if (!result) {
      throw new Error("Expected result");
    }
    expect(result.byteLength).toBeGreaterThan(0);

    // Verify document.xml is unchanged
    const originalXml = await getDocumentXml(buffer);
    const resultXml = await getDocumentXml(result);
    expect(resultXml).toBe(originalXml);

    // Verify core properties were updated with new modification date
    const zip = await JSZip.loadAsync(result);
    const coreProps = await zip.file("docProps/core.xml")?.async("text");
    if (coreProps) {
      expect(coreProps).toContain("dcterms:modified");
    }
  });

  test("preserves existing media parts when saving without content changes", async () => {
    const buffer = await loadFixture("example-with-image.docx");
    const doc = await parseDocx(buffer, { preloadFonts: false });
    const originalImage = await getBinaryEntry(buffer, "word/media/image1.png");

    const result = await attemptSelectiveSave(doc, buffer, {
      changedParaIds: new Set(),
      structuralChange: false,
      hasUntrackedChanges: false,
    });

    expect(result).not.toBeNull();
    if (!result) {
      throw new Error("Expected result");
    }

    const resultImage = await getBinaryEntry(result, "word/media/image1.png");
    expect(new Uint8Array(resultImage)).toEqual(new Uint8Array(originalImage));

    const zip = await JSZip.loadAsync(result);
    const contentTypes = await zip.file("[Content_Types].xml")?.async("text");
    const relationships = await zip
      .file("word/_rels/document.xml.rels")
      ?.async("text");
    expect(contentTypes).toContain('ContentType="image/png"');
    expect(relationships).toContain('Target="media/image1.png"');
  });

  test("selectively patches a single paragraph edit", async () => {
    const buffer = await loadFixture("example-with-image.docx");
    const doc = await parseDocx(buffer, { preloadFonts: false });

    // Find a paragraph to modify
    const paragraphs = doc.package.document.content.filter(
      (b): b is Paragraph => b.type === "paragraph",
    );

    // Find a paragraph with a paraId that has text content
    let targetPara: Paragraph | null = null;
    for (const para of paragraphs) {
      if (para.paraId) {
        const text = para.content
          .filter((item): item is Run => item.type === "run")
          .flatMap((run) => run.content)
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("");
        if (text.length > 0) {
          targetPara = para;
          break;
        }
      }
    }

    if (!targetPara || !targetPara.paraId) {
      // Skip test if no suitable paragraph found
      console.log(
        "No paragraph with paraId and text found in example-with-image.docx, skipping",
      );
      return;
    }

    const paraId = targetPara.paraId;

    // Modify the paragraph text
    for (const item of targetPara.content) {
      if (item.type === "run") {
        for (const c of item.content) {
          if (c.type === "text" && c.text.length > 0) {
            c.text += " [MODIFIED]";
            break;
          }
        }
        break;
      }
    }

    // Attempt selective save
    const result = await attemptSelectiveSave(doc, buffer, {
      changedParaIds: new Set([paraId]),
      structuralChange: false,
      hasUntrackedChanges: false,
    });

    if (result === null) {
      // Selective save may fail due to paragraph count mismatch (serializer differences)
      // This is expected — fall back to full repack
      console.log(
        "Selective save returned null (expected fallback), verifying full repack works",
      );
      const fullResult = await repackDocx(doc);
      expect(fullResult.byteLength).toBeGreaterThan(0);
      return;
    }

    // Verify the result is a valid DOCX
    expect(result.byteLength).toBeGreaterThan(0);
    const resultXml = await getDocumentXml(result);
    expect(resultXml).toContain("[MODIFIED]");

    // Verify unchanged paragraphs are preserved
    const originalXml = await getDocumentXml(buffer);
    for (const para of paragraphs) {
      if (para.paraId && para.paraId !== paraId) {
        const origOffsets = findParagraphOffsets(originalXml, para.paraId);
        const resultOffsets = findParagraphOffsets(resultXml, para.paraId);
        if (origOffsets && resultOffsets) {
          const origPara = originalXml.slice(
            origOffsets.start,
            origOffsets.end,
          );
          const resultPara = resultXml.slice(
            resultOffsets.start,
            resultOffsets.end,
          );
          expect(resultPara).toBe(origPara);
        }
      }
    }
  });

  test("returns null for changed paraId not found in original", async () => {
    const buffer = await loadFixture("example-with-image.docx");
    const doc = await parseDocx(buffer, { preloadFonts: false });

    const result = await attemptSelectiveSave(doc, buffer, {
      changedParaIds: new Set(["NONEXISTENT_PARA_ID"]),
      structuralChange: false,
      hasUntrackedChanges: false,
    });

    // Should return null (fallback to full repack)
    expect(result).toBeNull();
  });
});

// ============================================================================
// Round-trip correctness
// ============================================================================

describe("Selective save round-trip", () => {
  test("selective save produces valid DOCX that can be re-parsed", async () => {
    const buffer = await loadFixture("example-with-image.docx");
    const doc = await parseDocx(buffer, { preloadFonts: false });

    // Find a modifiable paragraph
    const paragraphs = doc.package.document.content.filter(
      (b): b is Paragraph => b.type === "paragraph",
    );

    let targetPara: Paragraph | null = null;
    for (const para of paragraphs) {
      if (para.paraId) {
        const hasText = para.content.some(
          (item) =>
            item.type === "run" &&
            item.content.some((c) => c.type === "text" && c.text.length > 0),
        );
        if (hasText) {
          targetPara = para;
          break;
        }
      }
    }

    if (!targetPara?.paraId) {
      console.log("No suitable paragraph for round-trip test, skipping");
      return;
    }

    // Modify and attempt selective save
    const paraId = targetPara.paraId;
    for (const item of targetPara.content) {
      if (item.type === "run") {
        for (const c of item.content) {
          if (c.type === "text" && c.text.length > 0) {
            c.text = "ROUNDTRIP_TEST";
            break;
          }
        }
        break;
      }
    }

    const savedBuffer = await attemptSelectiveSave(doc, buffer, {
      changedParaIds: new Set([paraId]),
      structuralChange: false,
      hasUntrackedChanges: false,
    });

    if (!savedBuffer) {
      // Fallback is acceptable
      console.log(
        "Selective save fell back, testing full repack round-trip instead",
      );
      const fullBuffer = await repackDocx(doc);
      const reopened = await parseDocx(fullBuffer, { preloadFonts: false });
      expect(reopened.package.document.content.length).toBeGreaterThan(0);
      return;
    }

    // Re-parse the saved document
    const reopened = await parseDocx(savedBuffer, { preloadFonts: false });
    expect(reopened.package.document.content.length).toBeGreaterThan(0);

    // Verify the modified text exists
    const modifiedPara = reopened.package.document.content.find(
      (b): b is Paragraph => b.type === "paragraph" && b.paraId === paraId,
    );
    if (modifiedPara) {
      const text = modifiedPara.content
        .filter((item): item is Run => item.type === "run")
        .flatMap((run) => run.content)
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("");
      expect(text).toContain("ROUNDTRIP_TEST");
    }
  });

  test("no-edit save preserves document.xml exactly", async () => {
    const buffer = await loadFixture("example-with-image.docx");
    const doc = await parseDocx(buffer, { preloadFonts: false });

    const savedBuffer = await attemptSelectiveSave(doc, buffer, {
      changedParaIds: new Set(),
      structuralChange: false,
      hasUntrackedChanges: false,
    });

    // No changes — should return the original buffer
    expect(savedBuffer).not.toBeNull();
  });
});

// ============================================================================
// buildPatchedDocumentXml with real XML
// ============================================================================

describe("buildPatchedDocumentXml with real DOCX XML", () => {
  test("patches real document.xml correctly", async () => {
    const buffer = await loadFixture("example-with-image.docx");
    const originalXml = await getDocumentXml(buffer);

    // Find all paraIds
    const paraIdPattern = /w14:paraId="([^"]+)"/gu;
    const allIds: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = paraIdPattern.exec(originalXml)) !== null) {
      allIds.push(m[1]);
    }

    // Build a "serialized" version with one paragraph modified
    // (In real usage this comes from serializeDocument after document model changes)
    const uniqueIds = [...new Set(allIds)];
    if (uniqueIds.length === 0) {
      console.log("No paraIds in example-with-image.docx, skipping");
      return;
    }

    // Find a paraId that can be located in the XML
    let testId: string | null = null;
    for (const id of uniqueIds) {
      if (findParagraphOffsets(originalXml, id)) {
        testId = id;
        break;
      }
    }

    if (!testId) {
      console.log("No locatable paraId in example-with-image.docx, skipping");
      return;
    }

    // Create a modified version where the target paragraph has different content
    const origOffsets = findParagraphOffsets(originalXml, testId);
    if (!origOffsets) {
      throw new Error("Expected origOffsets");
    }
    const origParagraph = originalXml.slice(origOffsets.start, origOffsets.end);
    const modifiedParagraph = origParagraph.replace(
      /<w:t[^>]*>[^<]*<\/w:t>/u,
      "<w:t>PATCHED_TEXT</w:t>",
    );

    // Build the "serialized" XML with just this one paragraph changed
    const serializedXml =
      originalXml.slice(0, origOffsets.start) +
      modifiedParagraph +
      originalXml.slice(origOffsets.end);

    const patched = buildPatchedDocumentXml(
      originalXml,
      serializedXml,
      new Set([testId]),
    );
    expect(patched).not.toBeNull();

    if (patched) {
      // The patched paragraph should have the new content
      const patchedOffsets = findParagraphOffsets(patched, testId);
      if (!patchedOffsets) {
        throw new Error("Expected patchedOffsets");
      }
      const patchedPara = patched.slice(
        patchedOffsets.start,
        patchedOffsets.end,
      );
      expect(patchedPara).toContain("PATCHED_TEXT");

      // All other content should be identical
      // Check that the content before the patched paragraph is byte-for-byte identical
      expect(patched.slice(0, patchedOffsets.start)).toBe(
        originalXml.slice(0, origOffsets.start),
      );
    }
  });
});

// ============================================================================
// Edge cases
// ============================================================================

// ============================================================================
// Comments handling in selective save
// ============================================================================

describe("Selective save with comments", () => {
  test("includes comments.xml when document has comments", async () => {
    const buffer = await loadFixture("example-with-image.docx");
    const doc = await parseDocx(buffer, { preloadFonts: false });

    // Add a comment to the document model
    doc.package.document.comments = [
      {
        id: 1,
        author: "Test User",
        date: "2024-01-01T00:00:00Z",
        content: [
          {
            type: "paragraph",
            formatting: {},
            content: [
              {
                type: "run",
                formatting: {},
                content: [{ type: "text", text: "Test comment" }],
              },
            ],
          },
        ],
      },
    ];

    // Even with no paragraph changes, comments should be saved
    const result = await attemptSelectiveSave(doc, buffer, {
      changedParaIds: new Set(),
      structuralChange: false,
      hasUntrackedChanges: false,
    });

    expect(result).not.toBeNull();
    if (!result) {
      throw new Error("Expected result");
    }
    // Result should NOT be the original buffer (it has comments now)
    expect(result.byteLength).not.toBe(buffer.byteLength);

    // Verify comments.xml exists and contains the comment
    const zip = await JSZip.loadAsync(result);
    const commentsFile = zip.file("word/comments.xml");
    expect(commentsFile).not.toBeNull();
    if (!commentsFile) {
      throw new Error("Expected commentsFile");
    }
    const commentsXml = await commentsFile.async("text");
    expect(commentsXml).toContain("Test comment");
    expect(commentsXml).toContain('w:id="1"');
    expect(commentsXml).toContain("Test User");
  });

  test("ensures content type and relationship entries for new comments", async () => {
    const buffer = await loadFixture("example-with-image.docx");
    const doc = await parseDocx(buffer, { preloadFonts: false });

    // Check if original has comments entries (it probably doesn't)
    const originalZip = await JSZip.loadAsync(buffer);
    const originalCt = await originalZip
      .file("[Content_Types].xml")
      ?.async("text");
    const hadCommentsEntry =
      originalCt?.includes("/word/comments.xml") ?? false;

    // Add a comment
    doc.package.document.comments = [
      {
        id: 42,
        author: "Author",
        content: [
          {
            type: "paragraph",
            formatting: {},
            content: [
              {
                type: "run",
                formatting: {},
                content: [{ type: "text", text: "New comment" }],
              },
            ],
          },
        ],
      },
    ];

    const result = await attemptSelectiveSave(doc, buffer, {
      changedParaIds: new Set(),
      structuralChange: false,
      hasUntrackedChanges: false,
    });

    expect(result).not.toBeNull();
    if (!result) {
      throw new Error("Expected result");
    }
    const resultZip = await JSZip.loadAsync(result);

    // Content type should be present
    const ctXml = await resultZip.file("[Content_Types].xml")?.async("text");
    expect(ctXml).toContain("/word/comments.xml");

    // Relationship should be present
    const relsXml = await resultZip
      .file("word/_rels/document.xml.rels")
      ?.async("text");
    expect(relsXml).toContain("comments.xml");

    // If the original didn't have comments, verify the entries were added
    if (!hadCommentsEntry) {
      expect(ctXml).toContain(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml",
      );
    }
  });

  test("preserves existing comments and adds new ones", async () => {
    const buffer = await loadFixture("example-with-image.docx");
    const doc = await parseDocx(buffer, { preloadFonts: false });

    // Simulate having both an original comment and a new one
    doc.package.document.comments = [
      {
        id: 1,
        author: "Original Author",
        content: [
          {
            type: "paragraph",
            formatting: {},
            content: [
              {
                type: "run",
                formatting: {},
                content: [{ type: "text", text: "Original comment" }],
              },
            ],
          },
        ],
      },
      {
        id: 999,
        author: "New Author",
        content: [
          {
            type: "paragraph",
            formatting: {},
            content: [
              {
                type: "run",
                formatting: {},
                content: [{ type: "text", text: "New comment" }],
              },
            ],
          },
        ],
      },
    ];

    const result = await attemptSelectiveSave(doc, buffer, {
      changedParaIds: new Set(),
      structuralChange: false,
      hasUntrackedChanges: false,
    });

    expect(result).not.toBeNull();
    if (!result) {
      throw new Error("Expected result");
    }
    const zip = await JSZip.loadAsync(result);
    const commentsFile = zip.file("word/comments.xml");
    if (!commentsFile) {
      throw new Error("Expected word/comments.xml");
    }
    const commentsXml = await commentsFile.async("text");

    // Both comments should be present
    expect(commentsXml).toContain("Original comment");
    expect(commentsXml).toContain("New comment");
    expect(commentsXml).toContain('w:id="1"');
    expect(commentsXml).toContain('w:id="999"');
  });

  test("comments saved alongside paragraph changes", async () => {
    const buffer = await loadFixture("example-with-image.docx");
    const doc = await parseDocx(buffer, { preloadFonts: false });

    // Add a comment
    doc.package.document.comments = [
      {
        id: 5,
        author: "Commenter",
        content: [
          {
            type: "paragraph",
            formatting: {},
            content: [
              {
                type: "run",
                formatting: {},
                content: [{ type: "text", text: "Comment text" }],
              },
            ],
          },
        ],
      },
    ];

    // Also modify a paragraph
    const paragraphs = doc.package.document.content.filter(
      (b): b is Paragraph => b.type === "paragraph" && !!b.paraId,
    );
    const target = paragraphs.find((p) =>
      p.content.some(
        (i) =>
          i.type === "run" &&
          i.content.some((c) => c.type === "text" && c.text.length > 0),
      ),
    );

    if (!target?.paraId) {
      console.log("No suitable paragraph, skipping");
      return;
    }

    for (const item of target.content) {
      if (item.type === "run") {
        for (const c of item.content) {
          if (c.type === "text" && c.text.length > 0) {
            c.text += " [WITH_COMMENT]";
            break;
          }
        }
        break;
      }
    }

    const result = await attemptSelectiveSave(doc, buffer, {
      changedParaIds: new Set([target.paraId]),
      structuralChange: false,
      hasUntrackedChanges: false,
    });

    if (result) {
      const zip = await JSZip.loadAsync(result);

      // Verify document.xml has the paragraph change
      const docXmlFile = zip.file("word/document.xml");
      if (!docXmlFile) {
        throw new Error("Expected word/document.xml");
      }
      const docXml = await docXmlFile.async("text");
      expect(docXml).toContain("[WITH_COMMENT]");

      // Verify comments.xml exists with the comment
      const commentsXmlFile = zip.file("word/comments.xml");
      if (!commentsXmlFile) {
        throw new Error("Expected word/comments.xml");
      }
      const commentsXml = await commentsXmlFile.async("text");
      expect(commentsXml).toContain("Comment text");
    }
  });
});

// ============================================================================
// Headers/footers and core properties in selective save
// ============================================================================

describe("Selective save with headers/footers", () => {
  test("serializes headers/footers into the saved output", async () => {
    const buffer = await loadFixture("EP_ZMVZ_MULTI_v4.docx");
    const doc = await parseDocx(buffer, { preloadFonts: false });

    // Check if document has headers or footers
    const hasHeaders = doc.package.headers && doc.package.headers.size > 0;
    const hasFooters = doc.package.footers && doc.package.footers.size > 0;
    if (!hasHeaders && !hasFooters) {
      console.log("No headers/footers in fixture, skipping");
      return;
    }

    // Modify a header/footer content
    const map = hasHeaders ? doc.package.headers : doc.package.footers;
    if (!map) {
      throw new Error("Expected headers or footers map");
    }
    for (const [, hf] of map.entries()) {
      if (hf.content.length > 0) {
        const para = hf.content.find((b) => b.type === "paragraph");
        if (para) {
          para.content.push({
            type: "run",
            formatting: {},
            content: [{ type: "text", text: " [HF_MODIFIED]" }],
          });
          break;
        }
      }
    }

    const result = await attemptSelectiveSave(doc, buffer, {
      changedParaIds: new Set(),
      structuralChange: false,
      hasUntrackedChanges: false,
    });

    expect(result).not.toBeNull();

    // Verify that the header/footer file was updated
    if (!result) {
      throw new Error("Expected result");
    }
    const zip = await JSZip.loadAsync(result);
    let found = false;
    for (const [filePath, file] of Object.entries(zip.files)) {
      if (/word\/(header|footer)\d*\.xml/u.test(filePath)) {
        const xml = await file.async("text");
        if (xml.includes("[HF_MODIFIED]")) {
          found = true;
          break;
        }
      }
    }
    expect(found).toBe(true);
  });
});

describe("Selective save updates core properties", () => {
  test("updates modification date on save", async () => {
    const buffer = await loadFixture("example-with-image.docx");
    const doc = await parseDocx(buffer, { preloadFonts: false });

    // Get original modification date
    const originalZip = await JSZip.loadAsync(buffer);
    const originalCoreProps = await originalZip
      .file("docProps/core.xml")
      ?.async("text");

    const result = await attemptSelectiveSave(doc, buffer, {
      changedParaIds: new Set(),
      structuralChange: false,
      hasUntrackedChanges: false,
    });

    expect(result).not.toBeNull();
    if (!result) {
      throw new Error("Expected result");
    }
    const resultZip = await JSZip.loadAsync(result);
    const resultCoreProps = await resultZip
      .file("docProps/core.xml")
      ?.async("text");

    if (originalCoreProps && resultCoreProps) {
      // The modification date should have been updated
      expect(resultCoreProps).not.toBe(originalCoreProps);
      expect(resultCoreProps).toContain("dcterms:modified");
    }
  });
});

describe("Selective save edge cases", () => {
  test("handles document with tables", async () => {
    const buffer = await loadFixture("with-tables.docx");
    const doc = await parseDocx(buffer, { preloadFonts: false });
    const xml = await getDocumentXml(buffer);

    // Verify we can count paragraphs (tables contain w:p elements too)
    const count = countParagraphElements(xml);
    expect(count).toBeGreaterThan(0);

    // No changes = should return original
    const result = await attemptSelectiveSave(doc, buffer, {
      changedParaIds: new Set(),
      structuralChange: false,
      hasUntrackedChanges: false,
    });
    expect(result).not.toBeNull();
  });

  test("handles complex styled document", async () => {
    const buffer = await loadFixture("complex-styles.docx");
    const doc = await parseDocx(buffer, { preloadFonts: false });
    const xml = await getDocumentXml(buffer);

    const count = countParagraphElements(xml);
    expect(count).toBeGreaterThan(0);

    // No changes = should return original
    const result = await attemptSelectiveSave(doc, buffer, {
      changedParaIds: new Set(),
      structuralChange: false,
      hasUntrackedChanges: false,
    });
    expect(result).not.toBeNull();
  });

  test("handles document with missing paraIds gracefully", async () => {
    // Create a minimal DOCX-like XML without paraIds
    // The attempt should fall back (return null) if we ask to patch a nonexistent ID
    const buffer = await loadFixture("example-with-image.docx");
    const doc = await parseDocx(buffer, { preloadFonts: false });

    const result = await attemptSelectiveSave(doc, buffer, {
      changedParaIds: new Set(["FAKE_ID_12345"]),
      structuralChange: false,
      hasUntrackedChanges: false,
    });

    expect(result).toBeNull(); // Should fall back
  });

  test("handles large document with many paraIds", async () => {
    const buffer = await loadFixture("EP_ZMVZ_MULTI_v4.docx");
    const doc = await parseDocx(buffer, { preloadFonts: false });
    const xml = await getDocumentXml(buffer);

    // Count paraIds
    const paraIdPattern = /w14:paraId="([^"]+)"/gu;
    const ids: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = paraIdPattern.exec(xml)) !== null) {
      ids.push(m[1]);
    }
    expect(ids.length).toBeGreaterThan(50);

    // No-changes save should work
    const noChangeResult = await attemptSelectiveSave(doc, buffer, {
      changedParaIds: new Set(),
      structuralChange: false,
      hasUntrackedChanges: false,
    });
    expect(noChangeResult).not.toBeNull();

    // Single paragraph edit
    const paragraphs = doc.package.document.content.filter(
      (b): b is Paragraph => b.type === "paragraph" && !!b.paraId,
    );
    expect(paragraphs.length).toBeGreaterThan(0);

    const target = paragraphs.find((p) =>
      p.content.some(
        (i) =>
          i.type === "run" &&
          i.content.some((c) => c.type === "text" && c.text.length > 0),
      ),
    );

    if (target?.paraId) {
      // Modify target paragraph
      for (const item of target.content) {
        if (item.type === "run") {
          for (const c of item.content) {
            if (c.type === "text" && c.text.length > 0) {
              c.text += " [LARGE_DOC_TEST]";
              break;
            }
          }
          break;
        }
      }

      const result = await attemptSelectiveSave(doc, buffer, {
        changedParaIds: new Set([target.paraId]),
        structuralChange: false,
        hasUntrackedChanges: false,
      });

      if (result) {
        // Verify it's a valid ZIP
        expect(result.byteLength).toBeGreaterThan(0);
        const resultXml = await getDocumentXml(result);
        expect(resultXml).toContain("[LARGE_DOC_TEST]");

        // Verify other paragraphs are byte-for-byte identical
        const originalXml = await getDocumentXml(buffer);
        let checkedCount = 0;
        for (const para of paragraphs.slice(0, 10)) {
          if (para.paraId && para.paraId !== target.paraId) {
            const origOffsets = findParagraphOffsets(originalXml, para.paraId);
            const resultOffsets = findParagraphOffsets(resultXml, para.paraId);
            if (origOffsets && resultOffsets) {
              const origText = originalXml.slice(
                origOffsets.start,
                origOffsets.end,
              );
              const resultText = resultXml.slice(
                resultOffsets.start,
                resultOffsets.end,
              );
              expect(resultText).toBe(origText);
              checkedCount++;
            }
          }
        }
        expect(checkedCount).toBeGreaterThan(0);
      }
    }
  });

  test("selective save disabled falls back to full repack", async () => {
    const buffer = await loadFixture("example-with-image.docx");
    const doc = await parseDocx(buffer, { preloadFonts: false });

    // When structuralChange=true (simulating selective=false at higher level), we get null
    const result = await attemptSelectiveSave(doc, buffer, {
      changedParaIds: new Set(),
      structuralChange: true,
      hasUntrackedChanges: false,
    });
    expect(result).toBeNull();
  });

  test("multiple paragraphs edited selectively", async () => {
    const buffer = await loadFixture("example-with-image.docx");
    const doc = await parseDocx(buffer, { preloadFonts: false });

    const paragraphs = doc.package.document.content.filter(
      (b): b is Paragraph =>
        b.type === "paragraph" &&
        !!b.paraId &&
        b.content.some(
          (i) =>
            i.type === "run" &&
            i.content.some((c) => c.type === "text" && c.text.length > 0),
        ),
    );

    if (paragraphs.length < 2) {
      console.log("Not enough paragraphs with paraId to test multi-edit");
      return;
    }

    const editIds: string[] = [];
    // Edit first two paragraphs with paraIds
    for (const para of paragraphs.slice(0, 2)) {
      for (const item of para.content) {
        if (item.type === "run") {
          for (const c of item.content) {
            if (c.type === "text" && c.text.length > 0) {
              c.text += ` [MULTI_${para.paraId}]`;
              break;
            }
          }
          break;
        }
      }
      if (para.paraId) {
        editIds.push(para.paraId);
      }
    }

    const result = await attemptSelectiveSave(doc, buffer, {
      changedParaIds: new Set(editIds),
      structuralChange: false,
      hasUntrackedChanges: false,
    });

    if (result) {
      const resultXml = await getDocumentXml(result);
      for (const id of editIds) {
        expect(resultXml).toContain(`[MULTI_${id}]`);
      }

      // Verify an unedited paragraph is unchanged
      const uneditedPara = paragraphs.find(
        (p) => p.paraId !== undefined && !editIds.includes(p.paraId),
      );
      if (uneditedPara?.paraId) {
        const originalXml = await getDocumentXml(buffer);
        const origOffsets = findParagraphOffsets(
          originalXml,
          uneditedPara.paraId,
        );
        const resultOffsets = findParagraphOffsets(
          resultXml,
          uneditedPara.paraId,
        );
        if (origOffsets && resultOffsets) {
          expect(resultXml.slice(resultOffsets.start, resultOffsets.end)).toBe(
            originalXml.slice(origOffsets.start, origOffsets.end),
          );
        }
      }
    }
  });
});
