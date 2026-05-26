import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import type { DocumentBody } from "../types/document";
import { parseNumbering } from "./numberingParser";
import { normalizeNumberingReferences } from "./numberingReferenceNormalization";
import { parseDocx } from "./parser";
import { RELATIONSHIP_TYPES } from "./relsParser";
import { repackDocx } from "./rezip";

const XML_DECLARATION =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

describe("normalizeNumberingReferences", () => {
  test("removes paragraph numbering references with no numbering definition", () => {
    const documentBody: DocumentBody = {
      content: [
        {
          type: "paragraph",
          formatting: { numPr: { numId: 2, ilvl: 0 } },
          content: [],
        },
      ],
    };

    const result = normalizeNumberingReferences({
      documentBody,
      numbering: parseNumbering(null),
    });

    expect(result).toEqual({
      removedMissingNumberingReferences: 1,
    });
    const block = documentBody.content.at(0);
    expect(block?.type).toBe("paragraph");
    if (block?.type !== "paragraph") {
      throw new Error("Expected first block to be a paragraph");
    }
    expect(block.formatting?.numPr).toBeUndefined();
  });

  test("removes missing numbering references from comment paragraphs", () => {
    const documentBody: DocumentBody = {
      content: [],
      comments: [
        {
          id: 1,
          author: "Reviewer",
          content: [
            {
              type: "paragraph",
              formatting: { numPr: { numId: 2, ilvl: 0 } },
              content: [],
            },
          ],
        },
      ],
    };

    const result = normalizeNumberingReferences({
      documentBody,
      numbering: parseNumbering(null),
    });

    expect(result).toEqual({
      removedMissingNumberingReferences: 1,
    });
    expect(
      documentBody.comments?.at(0)?.content.at(0)?.formatting?.numPr,
    ).toBeUndefined();
  });

  test("parses and saves documents that reference a missing numbering part", async () => {
    const buffer = await createMissingNumberingReferenceFixture();
    const doc = await parseDocx(buffer, { preloadFonts: false });
    const block = doc.package.document.content.at(0);

    expect(block?.type).toBe("paragraph");
    if (block?.type !== "paragraph") {
      throw new Error("Expected first block to be a paragraph");
    }
    expect(block.formatting?.numPr).toBeUndefined();
    expect(doc.warnings).toContain(
      "Removed 1 numbering reference(s) whose numbering definitions are missing.",
    );

    const repacked = await repackDocx(doc, { updateModifiedDate: false });
    const zip = await JSZip.loadAsync(repacked);
    const documentXml = await zip.file("word/document.xml")?.async("string");

    expect(documentXml).not.toContain("<w:numPr>");

    const reparsed = await parseDocx(repacked, { preloadFonts: false });
    const reparsedBlock = reparsed.package.document.content.at(0);

    expect(reparsedBlock?.type).toBe("paragraph");
    if (reparsedBlock?.type !== "paragraph") {
      throw new Error("Expected first reparsed block to be a paragraph");
    }
    expect(reparsedBlock.formatting?.numPr).toBeUndefined();
  });
});

const createMissingNumberingReferenceFixture =
  async (): Promise<ArrayBuffer> => {
    const zip = new JSZip();
    zip.file(
      "[Content_Types].xml",
      `${XML_DECLARATION}
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
    );
    zip.file(
      "_rels/.rels",
      `${XML_DECLARATION}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="${RELATIONSHIP_TYPES.officeDocument}" Target="word/document.xml"/>
</Relationships>`,
    );
    zip.file(
      "word/_rels/document.xml.rels",
      `${XML_DECLARATION}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`,
    );
    zip.file(
      "word/document.xml",
      `${XML_DECLARATION}
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:pPr>
        <w:numPr>
          <w:ilvl w:val="0"/>
          <w:numId w:val="2"/>
        </w:numPr>
      </w:pPr>
      <w:r><w:t>Body</w:t></w:r>
    </w:p>
  </w:body>
</w:document>`,
    );
    return zip.generateAsync({ type: "arraybuffer" });
  };
