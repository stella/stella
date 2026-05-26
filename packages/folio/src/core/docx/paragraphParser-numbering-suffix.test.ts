import { describe, expect, test } from "bun:test";

import { parseNumbering } from "./numberingParser";
import { parseParagraph } from "./paragraphParser";
import type { XmlElement } from "./xmlParser";
import { parseXmlDocument } from "./xmlParser";

const NUMBERING_WITH_SUFFIXES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="0">
    <w:lvl w:ilvl="0">
      <w:start w:val="1"/>
      <w:numFmt w:val="decimal"/>
      <w:lvlText w:val="%1."/>
      <w:suff w:val="space"/>
    </w:lvl>
  </w:abstractNum>
  <w:abstractNum w:abstractNumId="1">
    <w:lvl w:ilvl="0">
      <w:start w:val="1"/>
      <w:numFmt w:val="decimal"/>
      <w:lvlText w:val="%1."/>
      <w:suff w:val="nothing"/>
    </w:lvl>
  </w:abstractNum>
  <w:abstractNum w:abstractNumId="2">
    <w:lvl w:ilvl="0">
      <w:start w:val="1"/>
      <w:numFmt w:val="decimal"/>
      <w:lvlText w:val="%1."/>
    </w:lvl>
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
  <w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
  <w:num w:numId="3"><w:abstractNumId w:val="2"/></w:num>
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

describe("paragraphParser propagates w:suff to listRendering", () => {
  const numbering = parseNumbering(NUMBERING_WITH_SUFFIXES);

  test('w:suff="space" reaches listRendering.markerSuffix', () => {
    const paragraph = parseParagraphXml(
      `<w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:pPr>
          <w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>
        </w:pPr>
      </w:p>`,
      numbering,
    );

    expect(paragraph.listRendering?.markerSuffix).toBe("space");
  });

  test('w:suff="nothing" reaches listRendering.markerSuffix', () => {
    const paragraph = parseParagraphXml(
      `<w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:pPr>
          <w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr>
        </w:pPr>
      </w:p>`,
      numbering,
    );

    expect(paragraph.listRendering?.markerSuffix).toBe("nothing");
  });

  test("missing w:suff leaves markerSuffix undefined (callers default to 'tab')", () => {
    const paragraph = parseParagraphXml(
      `<w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:pPr>
          <w:numPr><w:ilvl w:val="0"/><w:numId w:val="3"/></w:numPr>
        </w:pPr>
      </w:p>`,
      numbering,
    );

    expect(paragraph.listRendering?.markerSuffix).toBeUndefined();
  });
});
