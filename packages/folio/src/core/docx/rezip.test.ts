import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import type { Document } from "../types/document";
import { parseDocx } from "./parser";
import { RELATIONSHIP_TYPES } from "./relsParser";
import { DocxPackageFidelityError, repackDocx } from "./rezip";
import { attemptSelectiveSave } from "./selectiveSave";

const XML_DECLARATION =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

const ONE_PIXEL_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

async function createHeaderFixture(): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `${XML_DECLARATION}
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
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
  <Relationship Id="rId1" Type="${RELATIONSHIP_TYPES.header}" Target="header1.xml"/>
</Relationships>`,
  );
  zip.file(
    "word/_rels/header1.xml.rels",
    `${XML_DECLARATION}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`,
  );
  zip.file(
    "word/document.xml",
    `${XML_DECLARATION}
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    <w:p><w:r><w:t>Body</w:t></w:r></w:p>
    <w:sectPr><w:headerReference w:type="default" r:id="rId1"/></w:sectPr>
  </w:body>
</w:document>`,
  );
  zip.file(
    "word/header1.xml",
    `${XML_DECLARATION}
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>`,
  );
  return zip.generateAsync({ type: "arraybuffer" });
}

async function createAlternateContentImageFixture(): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `${XML_DECLARATION}
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="emf" ContentType="image/x-emf"/>
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
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId5" Type="${RELATIONSHIP_TYPES.image}" Target="media/image1.emf"/>
</Relationships>`,
  );
  zip.file(
    "word/document.xml",
    `${XML_DECLARATION}
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
  <w:body>
    <w:p w14:paraId="IMG00001">
      <w:r>
        <mc:AlternateContent>
          <mc:Choice Requires="wps">
            <w:drawing>
              <wp:inline>
                <wp:extent cx="9525" cy="9525"/>
                <wp:docPr id="7" name="Unsupported vector image"/>
                <a:graphic>
                  <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
                    <pic:pic>
                      <pic:nvPicPr><pic:cNvPr id="7" name="image1.emf"/><pic:cNvPicPr/></pic:nvPicPr>
                      <pic:blipFill><a:blip r:embed="rId5"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
                      <pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="9525" cy="9525"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>
                    </pic:pic>
                  </a:graphicData>
                </a:graphic>
              </wp:inline>
            </w:drawing>
          </mc:Choice>
        </mc:AlternateContent>
      </w:r>
    </w:p>
    <w:p w14:paraId="TXT00001"><w:r><w:t>Editable text</w:t></w:r></w:p>
  </w:body>
</w:document>`,
  );
  zip.file("word/media/image1.emf", new Uint8Array([1, 2, 3, 4]));
  return zip.generateAsync({ type: "arraybuffer" });
}

async function createMultiSectionFirstHeaderImageFixture(): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `${XML_DECLARATION}
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
  <Override PartName="/word/header2.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
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
  <Relationship Id="rId11" Type="${RELATIONSHIP_TYPES.header}" Target="header1.xml"/>
  <Relationship Id="rId12" Type="${RELATIONSHIP_TYPES.header}" Target="header2.xml"/>
</Relationships>`,
  );
  zip.file(
    "word/_rels/header1.xml.rels",
    `${XML_DECLARATION}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="${RELATIONSHIP_TYPES.image}" Target="media/image1.png"/>
</Relationships>`,
  );
  zip.file(
    "word/document.xml",
    `${XML_DECLARATION}
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    <w:p w14:paraId="AAA00001">
      <w:r><w:t>First section text</w:t></w:r>
      <w:pPr>
        <w:sectPr>
          <w:headerReference w:type="first" r:id="rId11"/>
          <w:titlePg/>
        </w:sectPr>
      </w:pPr>
    </w:p>
    <w:p w14:paraId="BBB00001"><w:r><w:t>Second section text</w:t></w:r></w:p>
    <w:sectPr>
      <w:headerReference w:type="default" r:id="rId12"/>
    </w:sectPr>
  </w:body>
</w:document>`,
  );
  zip.file(
    "word/header1.xml",
    `${XML_DECLARATION}
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
  <w:p><w:r><w:drawing><wp:inline><wp:extent cx="9525" cy="9525"/><wp:docPr id="1" name="image1.png"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="image1.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="9525" cy="9525"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
</w:hdr>`,
  );
  zip.file(
    "word/header2.xml",
    `${XML_DECLARATION}
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Default header</w:t></w:r></w:p></w:hdr>`,
  );
  zip.file("word/media/image1.png", new Uint8Array([1, 2, 3, 4]));
  return zip.generateAsync({ type: "arraybuffer" });
}

describe("repackDocx", () => {
  test("registers newly inserted header images in the header relationship part", async () => {
    const originalBuffer = await createHeaderFixture();
    const document: Document = {
      originalBuffer,
      package: {
        document: {
          finalSectionProperties: {
            headerReferences: [{ type: "default", rId: "rId1" }],
          },
          content: [
            {
              type: "paragraph",
              content: [
                { type: "run", content: [{ type: "text", text: "Body" }] },
              ],
            },
          ],
        },
        relationships: new Map([
          [
            "rId1",
            {
              id: "rId1",
              type: RELATIONSHIP_TYPES.header,
              target: "header1.xml",
            },
          ],
        ]),
        headers: new Map([
          [
            "rId1",
            {
              type: "header",
              hdrFtrType: "default",
              content: [
                {
                  type: "paragraph",
                  content: [
                    {
                      type: "run",
                      content: [
                        {
                          type: "drawing",
                          image: {
                            type: "image",
                            rId: "rId_img_123",
                            src: ONE_PIXEL_PNG_DATA_URL,
                            filename: "header.png",
                            alt: "Header image",
                            size: { width: 9525, height: 9525 },
                            wrap: { type: "inline" },
                          },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        ]),
      },
    };

    const result = await repackDocx(document, { updateModifiedDate: false });
    const zip = await JSZip.loadAsync(result);
    const headerRels = await zip
      .file("word/_rels/header1.xml.rels")
      ?.async("text");
    const headerXml = await zip.file("word/header1.xml")?.async("text");

    expect(headerRels).toContain(`Type="${RELATIONSHIP_TYPES.image}"`);
    expect(headerRels).toContain('Target="media/image1.png"');
    expect(headerXml).toContain('r:embed="rId1"');
    expect(zip.file("word/media/image1.png")).not.toBeNull();
  });

  test("does not repackage existing header images that already have relationships", async () => {
    const originalBuffer = await createHeaderFixture();
    const originalZip = await JSZip.loadAsync(originalBuffer);
    originalZip.file("word/media/image1.png", new Uint8Array([1, 2, 3, 4]));
    originalZip.file(
      "word/_rels/header1.xml.rels",
      `${XML_DECLARATION}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="${RELATIONSHIP_TYPES.image}" Target="media/image1.png"/>
</Relationships>`,
    );
    const sourceBuffer = await originalZip.generateAsync({
      type: "arraybuffer",
    });
    const document: Document = {
      originalBuffer: sourceBuffer,
      package: {
        document: {
          finalSectionProperties: {
            headerReferences: [{ type: "default", rId: "rId1" }],
          },
          content: [
            {
              type: "paragraph",
              content: [
                { type: "run", content: [{ type: "text", text: "Body" }] },
              ],
            },
          ],
        },
        relationships: new Map([
          [
            "rId1",
            {
              id: "rId1",
              type: RELATIONSHIP_TYPES.header,
              target: "header1.xml",
            },
          ],
        ]),
        headers: new Map([
          [
            "rId1",
            {
              type: "header",
              hdrFtrType: "default",
              content: [
                {
                  type: "paragraph",
                  content: [
                    {
                      type: "run",
                      content: [
                        {
                          type: "drawing",
                          image: {
                            type: "image",
                            rId: "rId1",
                            src: ONE_PIXEL_PNG_DATA_URL,
                            filename: "image1.png",
                            size: { width: 9525, height: 9525 },
                            wrap: { type: "inline" },
                          },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        ]),
      },
    };

    const result = await repackDocx(document, { updateModifiedDate: false });
    const zip = await JSZip.loadAsync(result);
    const headerRels = await zip
      .file("word/_rels/header1.xml.rels")
      ?.async("text");
    const headerXml = await zip.file("word/header1.xml")?.async("text");
    const mediaFiles = Object.entries(zip.files)
      .filter(([path, file]) => path.startsWith("word/media/") && !file.dir)
      .map(([path]) => path);

    expect(headerRels?.match(/relationships\/image/g)).toHaveLength(1);
    expect(headerRels).toContain('Target="media/image1.png"');
    expect(headerXml).toContain('r:embed="rId1"');
    expect(mediaFiles).toEqual(["word/media/image1.png"]);
  });

  test("preserves package-referenced images that are not browser-renderable", async () => {
    const originalBuffer = await createAlternateContentImageFixture();
    const doc = await parseDocx(originalBuffer, { preloadFonts: false });

    const result = await repackDocx(doc, { updateModifiedDate: false });
    const zip = await JSZip.loadAsync(result);
    const documentXml = await zip.file("word/document.xml")?.async("text");

    expect(zip.file("word/media/image1.emf")).not.toBeNull();
    expect(documentXml).toContain("<mc:AlternateContent>");
    expect(documentXml).toContain('r:embed="rId5"');
  });

  test("full repack preserves first-section header image references", async () => {
    const originalBuffer = await createMultiSectionFirstHeaderImageFixture();
    const doc = await parseDocx(originalBuffer, { preloadFonts: false });

    const result = await repackDocx(doc, { updateModifiedDate: false });
    const zip = await JSZip.loadAsync(result);
    const documentXml = await zip.file("word/document.xml")?.async("text");
    const headerRelsXml = await zip
      .file("word/_rels/header1.xml.rels")
      ?.async("text");

    expect(documentXml).toContain(
      '<w:headerReference w:type="first" r:id="rId11"/>',
    );
    expect(documentXml).toContain("<w:titlePg/>");
    expect(headerRelsXml).toContain('Target="media/image1.png"');
    expect(zip.file("word/media/image1.png")).not.toBeNull();
  });

  test("fails closed when a repack would still orphan a header reference", async () => {
    const originalBuffer = await createMultiSectionFirstHeaderImageFixture();
    const doc = await parseDocx(originalBuffer, { preloadFonts: false });
    const firstParagraph = doc.package.document.content.find(
      (block) => block.type === "paragraph" && block.sectionProperties,
    );
    if (!firstParagraph || firstParagraph.type !== "paragraph") {
      throw new Error("Expected a section-ending paragraph");
    }
    delete firstParagraph.sectionProperties;

    try {
      await repackDocx(doc, { updateModifiedDate: false });
    } catch (error) {
      expect(error).toBeInstanceOf(DocxPackageFidelityError);
      return;
    }

    throw new Error("Expected repackDocx to reject");
  });

  test("selective save preserves first-section header image references", async () => {
    const originalBuffer = await createMultiSectionFirstHeaderImageFixture();
    const doc = await parseDocx(originalBuffer, { preloadFonts: false });

    const result = await attemptSelectiveSave(doc, originalBuffer, {
      changedParaIds: new Set(),
      structuralChange: false,
      hasUntrackedChanges: false,
    });
    expect(result).not.toBeNull();
    if (!result) {
      throw new Error("Expected selective save result");
    }

    const zip = await JSZip.loadAsync(result);
    const documentXml = await zip.file("word/document.xml")?.async("text");
    const headerRelsXml = await zip
      .file("word/_rels/header1.xml.rels")
      ?.async("text");

    expect(documentXml).toContain(
      '<w:headerReference w:type="first" r:id="rId11"/>',
    );
    expect(documentXml).toContain("<w:titlePg/>");
    expect(headerRelsXml).toContain('Target="media/image1.png"');
    expect(zip.file("word/media/image1.png")).not.toBeNull();
  });
});
