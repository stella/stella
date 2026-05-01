import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import type { Document } from "../types/document";
import { RELATIONSHIP_TYPES } from "./relsParser";
import { repackDocx } from "./rezip";

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

describe("repackDocx", () => {
  test("registers newly inserted header images in the header relationship part", async () => {
    const originalBuffer = await createHeaderFixture();
    const document: Document = {
      originalBuffer,
      package: {
        document: {
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
});
