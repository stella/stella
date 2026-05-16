import { describe, expect, test } from "bun:test";

import type { Paragraph } from "../types/document";
import { parseDocumentBody } from "./documentParser";
import { parseNumbering } from "./numberingParser";

const XML_DECLARATION =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

const numberingXml = `${XML_DECLARATION}
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="1">
    <w:lvl w:ilvl="0">
      <w:start w:val="1"/>
      <w:numFmt w:val="lowerLetter"/>
      <w:lvlText w:val="%1"/>
    </w:lvl>
    <w:lvl w:ilvl="1">
      <w:start w:val="1"/>
      <w:numFmt w:val="lowerLetter"/>
      <w:lvlText w:val="%1.%2"/>
    </w:lvl>
    <w:lvl w:ilvl="2">
      <w:start w:val="1"/>
      <w:numFmt w:val="decimal"/>
      <w:isLgl/>
      <w:lvlText w:val="%1.%2.%3"/>
    </w:lvl>
  </w:abstractNum>
  <w:num w:numId="9">
    <w:abstractNumId w:val="1"/>
  </w:num>
  <w:num w:numId="10">
    <w:abstractNumId w:val="1"/>
  </w:num>
</w:numbering>`;

const numberedParagraphXml = (
  paraId: string,
  ilvl: number,
  text: string,
  numId = 9,
) =>
  `<w:p w14:paraId="${paraId}"><w:pPr><w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;

const textBoxDrawingXml = (text: string) => `
  <w:drawing>
    <wp:inline>
      <wp:extent cx="914400" cy="457200"/>
      <wp:docPr id="11" name="Text Box 11"/>
      <a:graphic>
        <a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">
          <wps:wsp>
            <wps:spPr>
              <a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="457200"/></a:xfrm>
              <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
            </wps:spPr>
            <wps:txbx>
              <w:txbxContent>
                <w:p><w:r><w:t>${text}</w:t></w:r></w:p>
              </w:txbxContent>
            </wps:txbx>
            <wps:bodyPr/>
          </wps:wsp>
        </a:graphicData>
      </a:graphic>
    </wp:inline>
  </w:drawing>`;

describe("parseDocumentBody list numbering", () => {
  test("renders legal multilevel numbering with decimal parent counters", () => {
    const numbering = parseNumbering(numberingXml);
    const paragraphs: string[] = [];

    for (let index = 1; index <= 7; index += 1) {
      paragraphs.push(numberedParagraphXml(`L0${index}`, 0, `Level ${index}`));
    }
    for (let index = 1; index <= 5; index += 1) {
      paragraphs.push(
        numberedParagraphXml(`L1${index}`, 1, `Level 7.${index}`),
      );
    }
    paragraphs.push(numberedParagraphXml("L201", 2, "Level 7.5.1"));

    const body = parseDocumentBody(
      `${XML_DECLARATION}
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml">
  <w:body>${paragraphs.join("")}</w:body>
</w:document>`,
      null,
      null,
      numbering,
    );
    const listParagraphs = body.content.filter(
      (block): block is Paragraph => block.type === "paragraph",
    );

    expect(listParagraphs.at(-1)?.listRendering?.marker).toBe("7.5.1");
    expect(listParagraphs.at(-1)?.listRendering?.levelNumFmts).toEqual([
      "decimal",
      "decimal",
      "decimal",
    ]);
  });

  test("carries parent counters across concrete numIds that share an abstract numbering definition", () => {
    const numbering = parseNumbering(numberingXml);
    const paragraphs: string[] = [];

    for (let index = 1; index <= 7; index += 1) {
      paragraphs.push(numberedParagraphXml(`L0${index}`, 0, `Level ${index}`));
    }
    for (let index = 1; index <= 5; index += 1) {
      paragraphs.push(
        numberedParagraphXml(`L1${index}`, 1, `Level 7.${index}`),
      );
    }
    paragraphs.push(numberedParagraphXml("L201", 2, "Level 7.5.1", 10));

    const body = parseDocumentBody(
      `${XML_DECLARATION}
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml">
  <w:body>${paragraphs.join("")}</w:body>
</w:document>`,
      null,
      null,
      numbering,
    );
    const listParagraphs = body.content.filter(
      (block): block is Paragraph => block.type === "paragraph",
    );

    expect(listParagraphs.at(-1)?.listRendering?.marker).toBe("7.5.1");
  });
});

describe("parseDocumentBody text box enrichment", () => {
  test("keeps text boxes from merged runs before following boundaries", () => {
    const body = parseDocumentBody(`${XML_DECLARATION}
<w:document
  xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"
  xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">
  <w:body>
    <w:p w14:paraId="TXB00001">
      <w:r><w:t>Before </w:t></w:r>
      <w:r><w:t>merged</w:t>${textBoxDrawingXml("Inside text box")}</w:r>
      <w:bookmarkStart w:id="1" w:name="afterTextbox"/>
      <w:bookmarkEnd w:id="1"/>
      <w:r><w:t>After boundary</w:t></w:r>
    </w:p>
  </w:body>
</w:document>`);

    const paragraph = body.content.at(0);
    expect(paragraph?.type).toBe("paragraph");
    if (!paragraph || paragraph.type !== "paragraph") {
      return;
    }

    const firstRun = paragraph.content.at(0);
    expect(firstRun?.type).toBe("run");
    if (!firstRun || firstRun.type !== "run") {
      return;
    }

    expect(firstRun.content.map((content) => content.type)).toEqual([
      "text",
      "shape",
    ]);
    expect(firstRun.content.at(0)).toMatchObject({
      type: "text",
      text: "Before merged",
    });

    const shapeContent = firstRun.content.at(1);
    expect(shapeContent?.type).toBe("shape");
    if (!shapeContent || shapeContent.type !== "shape") {
      return;
    }
    expect(shapeContent.shape.shapeType).toBe("textBox");
    expect(shapeContent.shape.textBody?.content.at(0)?.type).toBe("paragraph");

    const bookmarkStartIndex = paragraph.content.findIndex(
      (content) => content.type === "bookmarkStart",
    );
    expect(bookmarkStartIndex).toBeGreaterThan(0);

    let hasShapeAfterBoundary = false;
    for (const content of paragraph.content.slice(bookmarkStartIndex + 1)) {
      if (content.type !== "run") {
        continue;
      }
      hasShapeAfterBoundary ||= content.content.some(
        (runContent) => runContent.type === "shape",
      );
    }
    expect(hasShapeAfterBoundary).toBe(false);
  });

  test("preserves textbox-only runs between same-format text runs", () => {
    const body = parseDocumentBody(`${XML_DECLARATION}
<w:document
  xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"
  xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">
  <w:body>
    <w:p w14:paraId="TXB00002">
      <w:r><w:t>Before</w:t></w:r>
      <w:r>${textBoxDrawingXml("Middle text box")}</w:r>
      <w:r><w:t>After</w:t></w:r>
    </w:p>
  </w:body>
</w:document>`);

    const paragraph = body.content.at(0);
    expect(paragraph?.type).toBe("paragraph");
    if (!paragraph || paragraph.type !== "paragraph") {
      return;
    }

    expect(paragraph.content.map((content) => content.type)).toEqual([
      "run",
      "run",
      "run",
    ]);

    const middleRun = paragraph.content.at(1);
    expect(middleRun?.type).toBe("run");
    if (!middleRun || middleRun.type !== "run") {
      return;
    }
    expect(middleRun.content.at(0)?.type).toBe("shape");
  });
});
