import { describe, expect, test } from "bun:test";

import { parseNumbering } from "./numberingParser";
import { parseParagraph } from "./paragraphParser";
import type { XmlElement } from "./xmlParser";
import { parseXmlDocument } from "./xmlParser";

// abstractNum 0 / numId 1 — level 0 carries the canonical numbered-list
// indent: left=720, hanging=360 (a half-inch hanging slot).
const NUMBERING_WITH_HANGING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="0">
    <w:lvl w:ilvl="0">
      <w:start w:val="1"/>
      <w:numFmt w:val="decimal"/>
      <w:lvlText w:val="%1."/>
      <w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr>
    </w:lvl>
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>`;

function parseParagraphXml(
  xml: string,
  numbering: ReturnType<typeof parseNumbering>,
) {
  const root = parseXmlDocument(xml) as XmlElement | null;
  if (!root) {
    throw new Error("Failed to parse paragraph XML");
  }
  return parseParagraph(root, null, null, numbering, null, null);
}

describe("paragraphParser direct ind vs numbering level indent", () => {
  const numbering = parseNumbering(NUMBERING_WITH_HANGING);

  test('w:firstLine="0" on a numbered paragraph is neutral (keeps level hanging)', () => {
    // ECMA-376 §17.3.1.12: a zero-valued direct ind should not suppress
    // the numbering level's hanging slot. Word + LibreOffice both keep
    // the bullet hanging here.
    const paragraph = parseParagraphXml(
      `<w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:pPr>
          <w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>
          <w:ind w:firstLine="0"/>
        </w:pPr>
        <w:r><w:t>Item</w:t></w:r>
      </w:p>`,
      numbering,
    );

    expect(paragraph.formatting?.indentLeft).toBe(720);
    expect(paragraph.formatting?.indentFirstLine).toBe(-360);
    expect(paragraph.formatting?.hangingIndent).toBe(true);
  });

  test('w:hanging="0" on a numbered paragraph is neutral (keeps level hanging)', () => {
    const paragraph = parseParagraphXml(
      `<w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:pPr>
          <w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>
          <w:ind w:hanging="0"/>
        </w:pPr>
        <w:r><w:t>Item</w:t></w:r>
      </w:p>`,
      numbering,
    );

    expect(paragraph.formatting?.indentLeft).toBe(720);
    expect(paragraph.formatting?.indentFirstLine).toBe(-360);
    expect(paragraph.formatting?.hangingIndent).toBe(true);
  });

  test("non-zero w:firstLine overrides the level hanging", () => {
    const paragraph = parseParagraphXml(
      `<w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:pPr>
          <w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>
          <w:ind w:firstLine="200"/>
        </w:pPr>
        <w:r><w:t>Item</w:t></w:r>
      </w:p>`,
      numbering,
    );

    expect(paragraph.formatting?.indentFirstLine).toBe(200);
    expect(paragraph.formatting?.hangingIndent).toBeUndefined();
  });

  test("non-zero w:hanging overrides the level hanging", () => {
    const paragraph = parseParagraphXml(
      `<w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:pPr>
          <w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>
          <w:ind w:hanging="180"/>
        </w:pPr>
        <w:r><w:t>Item</w:t></w:r>
      </w:p>`,
      numbering,
    );

    expect(paragraph.formatting?.indentFirstLine).toBe(-180);
    expect(paragraph.formatting?.hangingIndent).toBe(true);
  });
});
