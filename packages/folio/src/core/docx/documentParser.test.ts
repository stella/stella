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

const repeatedPlaceholderNumberingXml = `${XML_DECLARATION}
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="2">
    <w:lvl w:ilvl="0">
      <w:start w:val="1"/>
      <w:numFmt w:val="lowerLetter"/>
      <w:lvlText w:val="%1.%1"/>
    </w:lvl>
  </w:abstractNum>
  <w:num w:numId="11">
    <w:abstractNumId w:val="2"/>
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

  test("renders repeated placeholders and repeated-letter counters after z", () => {
    const numbering = parseNumbering(repeatedPlaceholderNumberingXml);
    const paragraphs = Array.from({ length: 28 }, (_unused, index) =>
      numberedParagraphXml(
        `R${String(index + 1).padStart(2, "0")}`,
        0,
        `Item ${index + 1}`,
        11,
      ),
    );

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

    expect(listParagraphs.at(0)?.listRendering?.marker).toBe("a.a");
    expect(listParagraphs.at(25)?.listRendering?.marker).toBe("z.z");
    expect(listParagraphs.at(26)?.listRendering?.marker).toBe("aa.aa");
    expect(listParagraphs.at(27)?.listRendering?.marker).toBe("bb.bb");
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

  // Regression: Word stores anchored wps:wsp text boxes inside an
  // <mc:AlternateContent> block — Choice Requires="wps" holds the modern
  // shape, Fallback holds a VML rendering. scanRunForTextBoxDrawings only
  // walked the direct children of <w:r>, so the <w:drawing> inside the
  // Choice branch never reached the text-box pipeline and the shape text
  // (e.g. "Organisation Chart" cards) was silently dropped (eigenpal #567).
  test("extracts text-box drawings wrapped in mc:AlternateContent", () => {
    const body = parseDocumentBody(`${XML_DECLARATION}
<w:document
  xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"
  xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"
  xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">
  <w:body>
    <w:p w14:paraId="ACTB0001">
      <w:r><w:t>Host text</w:t></w:r>
      <w:r>
        <mc:AlternateContent>
          <mc:Choice Requires="wps">${textBoxDrawingXml("Card title")}</mc:Choice>
          <mc:Fallback>
            <w:pict><v:shape><v:textbox><w:txbxContent><w:p><w:r><w:t>VML fallback</w:t></w:r></w:p></w:txbxContent></v:textbox></v:shape></w:pict>
          </mc:Fallback>
        </mc:AlternateContent>
      </w:r>
    </w:p>
  </w:body>
</w:document>`);

    const paragraph = body.content.at(0);
    if (paragraph?.type !== "paragraph") {
      throw new Error("Expected paragraph");
    }

    const shapes = paragraph.content
      .filter((c) => c.type === "run")
      .flatMap((r) => r.content.filter((c) => c.type === "shape"));

    expect(shapes).toHaveLength(1);
    const shape = shapes.at(0);
    if (!shape) {
      throw new Error("Expected shape");
    }
    expect(shape.shape.shapeType).toBe("textBox");
    const innerPara = shape.shape.textBody?.content.at(0);
    if (innerPara?.type !== "paragraph") {
      throw new Error("Expected text-box inner paragraph");
    }
    const innerRun = innerPara.content.at(0);
    if (innerRun?.type !== "run") {
      throw new Error("Expected text-box inner run");
    }
    const innerText = innerRun.content.at(0);
    if (innerText?.type !== "text") {
      throw new Error("Expected text-box inner text");
    }
    expect(innerText.text).toBe("Card title");
  });

  // Regression: with multiple AlternateContent-only <w:r> elements followed by
  // a text run, the strict `parsedIndex < paragraph.content.length` check used
  // to drop shapes past the first (consolidateParagraphContent collapses
  // shape-only <w:r> into the surrounding parsed runs). All shapes must
  // survive — anchored boxes are off-flow, the owning run matters less than
  // keeping them in the model so downstream positioning has something to
  // position.
  test("preserves multiple AlternateContent-only runs in the same paragraph", () => {
    const body = parseDocumentBody(`${XML_DECLARATION}
<w:document
  xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"
  xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"
  xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">
  <w:body>
    <w:p w14:paraId="ACTB0002">
      <w:r><mc:AlternateContent><mc:Choice Requires="wps">${textBoxDrawingXml("Card 1")}</mc:Choice><mc:Fallback><w:pict/></mc:Fallback></mc:AlternateContent></w:r>
      <w:r><mc:AlternateContent><mc:Choice Requires="wps">${textBoxDrawingXml("Card 2")}</mc:Choice><mc:Fallback><w:pict/></mc:Fallback></mc:AlternateContent></w:r>
      <w:r><mc:AlternateContent><mc:Choice Requires="wps">${textBoxDrawingXml("Card 3")}</mc:Choice><mc:Fallback><w:pict/></mc:Fallback></mc:AlternateContent></w:r>
      <w:r><w:t>Trailing text</w:t></w:r>
    </w:p>
  </w:body>
</w:document>`);

    const paragraph = body.content.at(0);
    if (paragraph?.type !== "paragraph") {
      throw new Error("Expected paragraph");
    }

    const cardTitles = paragraph.content
      .filter((c) => c.type === "run")
      .flatMap((r) => r.content.filter((c) => c.type === "shape"))
      .map((shape) => {
        const inner = shape.shape.textBody?.content.at(0);
        if (inner?.type !== "paragraph") {
          return null;
        }
        const run = inner.content.at(0);
        if (run?.type !== "run") {
          return null;
        }
        const text = run.content.at(0);
        return text?.type === "text" ? text.text : null;
      });

    expect(cardTitles).toEqual(["Card 1", "Card 2", "Card 3"]);
  });
});

describe("parseDocumentBody bookmark placement", () => {
  test("attaches body-level bookmark markers to adjacent paragraphs", () => {
    const body = parseDocumentBody(`${XML_DECLARATION}
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:bookmarkStart w:id="1" w:name="beforeFirst"/>
    <w:p>
      <w:r><w:t>First</w:t></w:r>
      <w:bookmarkStart w:id="2" w:name="afterParagraph"/>
    </w:p>
    <w:bookmarkEnd w:id="2"/>
    <w:p><w:r><w:t>Second</w:t></w:r></w:p>
    <w:bookmarkEnd w:id="1"/>
  </w:body>
</w:document>`);

    const firstParagraph = body.content.at(0);
    expect(firstParagraph?.type).toBe("paragraph");
    if (!firstParagraph || firstParagraph.type !== "paragraph") {
      return;
    }

    expect(firstParagraph.content.at(0)).toMatchObject({
      type: "bookmarkStart",
      id: 1,
    });
    expect(firstParagraph.content.at(-1)).toMatchObject({
      type: "bookmarkEnd",
      id: 2,
    });

    const secondParagraph = body.content.at(1);
    expect(secondParagraph?.type).toBe("paragraph");
    if (!secondParagraph || secondParagraph.type !== "paragraph") {
      return;
    }

    expect(secondParagraph.content.at(-1)).toMatchObject({
      type: "bookmarkEnd",
      id: 1,
    });
  });
});
