import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import type {
  DocumentBody,
  HeaderFooter,
  SectionProperties,
} from "../types/document";
import { normalizeHeaderFooterReferences } from "./headerFooterReferenceNormalization";
import { parseDocx } from "./parser";
import { RELATIONSHIP_TYPES } from "./relsParser";
import { repackDocx } from "./rezip";

const XML_DECLARATION =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

describe("normalizeHeaderFooterReferences", () => {
  test("removes dangling section header and footer references", () => {
    const sectionProperties: SectionProperties = {
      headerReferences: [
        { type: "default", rId: "rIdHeader" },
        { type: "even", rId: "rIdMissingHeader" },
      ],
      footerReferences: [
        { type: "default", rId: "rIdFooter" },
        { type: "first", rId: "rIdMissingFooter" },
      ],
    };
    const documentBody: DocumentBody = {
      content: [
        {
          type: "paragraph",
          sectionProperties,
          content: [],
        },
      ],
    };

    const result = normalizeHeaderFooterReferences({
      documentBody,
      headers: new Map([["rIdHeader", headerFooter("header")]]),
      footers: new Map([["rIdFooter", headerFooter("footer")]]),
    });

    expect(result).toEqual({
      removedDanglingHeaderReferences: 1,
      removedDanglingFooterReferences: 1,
    });
    expect(sectionProperties.headerReferences).toEqual([
      { type: "default", rId: "rIdHeader" },
    ]);
    expect(sectionProperties.footerReferences).toEqual([
      { type: "default", rId: "rIdFooter" },
    ]);
  });

  test("parses and saves documents with dangling footer references", async () => {
    const buffer = await createDanglingFooterReferenceFixture();
    const doc = await parseDocx(buffer, { preloadFonts: false });
    const block = doc.package.document.content.at(0);

    expect(block?.type).toBe("paragraph");
    if (block?.type !== "paragraph") {
      throw new Error("Expected first block to be a paragraph");
    }
    expect(block.sectionProperties?.footerReferences).toEqual([
      { type: "default", rId: "rId1" },
    ]);
    expect(doc.warnings).toContain(
      "Removed 1 dangling footer reference(s) whose footer parts are missing.",
    );

    const repacked = await repackDocx(doc, { updateModifiedDate: false });
    const reparsed = await parseDocx(repacked, { preloadFonts: false });
    const reparsedBlock = reparsed.package.document.content.at(0);

    expect(reparsedBlock?.type).toBe("paragraph");
    if (reparsedBlock?.type !== "paragraph") {
      throw new Error("Expected first reparsed block to be a paragraph");
    }
    expect(reparsedBlock.sectionProperties?.footerReferences).toEqual([
      { type: "default", rId: "rId1" },
    ]);
  });

  test("preserves non-numbered relationship-targeted header and footer parts", async () => {
    const buffer = await createNonNumberedHeaderFooterReferenceFixture();
    const doc = await parseDocx(buffer, { preloadFonts: false });
    const block = doc.package.document.content.at(0);

    expect(doc.package.headers?.has("rId1")).toBe(true);
    expect(doc.package.footers?.has("rId2")).toBe(true);
    expect(block?.type).toBe("paragraph");
    if (block?.type !== "paragraph") {
      throw new Error("Expected first block to be a paragraph");
    }
    expect(block.sectionProperties?.headerReferences).toEqual([
      { type: "default", rId: "rId1" },
    ]);
    expect(block.sectionProperties?.footerReferences).toEqual([
      { type: "default", rId: "rId2" },
    ]);
    expect(doc.warnings ?? []).not.toContain(
      "Removed 1 dangling header reference(s) whose header parts are missing.",
    );
    expect(doc.warnings ?? []).not.toContain(
      "Removed 1 dangling footer reference(s) whose footer parts are missing.",
    );

    const repacked = await repackDocx(doc, { updateModifiedDate: false });
    const zip = await JSZip.loadAsync(repacked);
    expect(zip.file("word/customHeaders/defaultHeader.xml")).toBeTruthy();
    expect(zip.file("word/customFooters/defaultFooter.xml")).toBeTruthy();

    const reparsed = await parseDocx(repacked, { preloadFonts: false });
    const reparsedBlock = reparsed.package.document.content.at(0);

    expect(reparsedBlock?.type).toBe("paragraph");
    if (reparsedBlock?.type !== "paragraph") {
      throw new Error("Expected first reparsed block to be a paragraph");
    }
    expect(reparsedBlock.sectionProperties?.headerReferences).toEqual([
      { type: "default", rId: "rId1" },
    ]);
    expect(reparsedBlock.sectionProperties?.footerReferences).toEqual([
      { type: "default", rId: "rId2" },
    ]);
  });
});

const headerFooter = (type: "header" | "footer"): HeaderFooter => ({
  type,
  hdrFtrType: "default",
  content: [],
});

const createDanglingFooterReferenceFixture = async (): Promise<ArrayBuffer> => {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `${XML_DECLARATION}
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>
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
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="${RELATIONSHIP_TYPES.footer}" Target="footer1.xml"/>
</Relationships>`,
  );
  zip.file(
    "word/document.xml",
    `${XML_DECLARATION}
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    <w:p>
      <w:pPr>
        <w:sectPr>
          <w:footerReference w:type="default" r:id="rId1"/>
          <w:footerReference w:type="even" r:id="rId12"/>
        </w:sectPr>
      </w:pPr>
      <w:r><w:t>Body</w:t></w:r>
    </w:p>
  </w:body>
</w:document>`,
  );
  zip.file(
    "word/footer1.xml",
    `${XML_DECLARATION}
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:p><w:r><w:t>Footer</w:t></w:r></w:p>
</w:ftr>`,
  );
  return zip.generateAsync({ type: "arraybuffer" });
};

const createNonNumberedHeaderFooterReferenceFixture =
  async (): Promise<ArrayBuffer> => {
    const zip = new JSZip();
    zip.file(
      "[Content_Types].xml",
      `${XML_DECLARATION}
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/customHeaders/defaultHeader.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
  <Override PartName="/word/customFooters/defaultFooter.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>
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
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="${RELATIONSHIP_TYPES.header}" Target="customHeaders/defaultHeader.xml"/>
  <Relationship Id="rId2" Type="${RELATIONSHIP_TYPES.footer}" Target="customFooters/defaultFooter.xml"/>
</Relationships>`,
    );
    zip.file(
      "word/document.xml",
      `${XML_DECLARATION}
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    <w:p>
      <w:pPr>
        <w:sectPr>
          <w:headerReference w:type="default" r:id="rId1"/>
          <w:footerReference w:type="default" r:id="rId2"/>
        </w:sectPr>
      </w:pPr>
      <w:r><w:t>Body</w:t></w:r>
    </w:p>
  </w:body>
</w:document>`,
    );
    zip.file(
      "word/customHeaders/defaultHeader.xml",
      `${XML_DECLARATION}
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:p><w:r><w:t>Header</w:t></w:r></w:p>
</w:hdr>`,
    );
    zip.file(
      "word/customFooters/defaultFooter.xml",
      `${XML_DECLARATION}
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:p><w:r><w:t>Footer</w:t></w:r></w:p>
</w:ftr>`,
    );
    return zip.generateAsync({ type: "arraybuffer" });
  };
