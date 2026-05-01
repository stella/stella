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
