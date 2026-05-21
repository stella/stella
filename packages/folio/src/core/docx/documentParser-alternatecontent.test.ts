// Regression eigenpal #567: Word stores anchored wps:wsp text boxes inside
// an <mc:AlternateContent> block (Choice Requires="wps" + Fallback VML).
// scanRunForTextBoxDrawings only walked direct children of <w:r>, so the
// <w:drawing> inside the Choice branch never reached the text-box pipeline
// and the shape text (e.g. "Organisation Chart" cards) was silently dropped.

import { describe, expect, test } from "bun:test";

import { parseDocumentBody } from "./documentParser";

const XML_DECLARATION =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

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

describe("parseDocumentBody — AlternateContent text boxes", () => {
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
  // a text run, a strict index check could drop shapes past the first (since
  // consolidateParagraphContent collapses shape-only <w:r> into surrounding
  // parsed runs). All shapes must survive.
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
