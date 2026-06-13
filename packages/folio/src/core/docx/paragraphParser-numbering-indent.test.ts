import { describe, expect, test } from "bun:test";

import { parseNumbering } from "./numberingParser";
import { parseParagraph } from "./paragraphParser";
import { parseStyles } from "./styleParser";
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

const W =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

// abstractNum 10 / numId 2 — level 0 carries a 360/360 hanging slot, the same
// level a style with its own wider indent references (#765 AppBody-Claim).
const NUMBERING_360 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering ${W}>
  <w:abstractNum w:abstractNumId="10">
    <w:lvl w:ilvl="0">
      <w:start w:val="1"/>
      <w:numFmt w:val="decimal"/>
      <w:lvlText w:val="[Claim %1]"/>
      <w:pPr><w:ind w:left="360" w:hanging="360"/></w:pPr>
    </w:lvl>
  </w:abstractNum>
  <w:num w:numId="2"><w:abstractNumId w:val="10"/></w:num>
</w:numbering>`;

// AppBody-Claim attaches numbering via the style pPr and defines its own wider
// indent (1134/1134); NoIndentNumbered attaches the same numbering but defines
// no indent of its own.
const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${W}>
  <w:style w:type="paragraph" w:styleId="ListParagraph">
    <w:name w:val="List Paragraph"/>
    <w:pPr><w:ind w:left="720"/></w:pPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="AppBody-Claim">
    <w:name w:val="AppBody-Claim"/>
    <w:basedOn w:val="ListParagraph"/>
    <w:pPr>
      <w:numPr><w:numId w:val="2"/></w:numPr>
      <w:ind w:left="1134" w:hanging="1134"/>
    </w:pPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="NoIndentNumbered">
    <w:name w:val="NoIndentNumbered"/>
    <w:pPr>
      <w:numPr><w:numId w:val="2"/></w:numPr>
    </w:pPr>
  </w:style>
</w:styles>`;

function parseStyledParagraph(
  inner: string,
  styles: ReturnType<typeof parseStyles>,
  numbering: ReturnType<typeof parseNumbering>,
) {
  const root = parseXmlDocument(
    `<w:p ${W}>${inner}</w:p>`,
  ) as XmlElement | null;
  if (!root) {
    throw new Error("Failed to parse paragraph XML");
  }
  return parseParagraph(root, styles, null, numbering, null, null);
}

describe("style-attached numbering and indentation (#765)", () => {
  const numbering = parseNumbering(NUMBERING_360);
  const styles = parseStyles(STYLES_XML, null);

  test("style ind wins over numbering level ind when numPr comes from the style", () => {
    const para = parseStyledParagraph(
      '<w:pPr><w:pStyle w:val="AppBody-Claim"/></w:pPr>',
      styles,
      numbering,
    );
    expect(para.listRendering?.marker).toBe("[Claim %1]");
    // The level's 360/360 must NOT be baked into the paragraph formatting;
    // the style's 1134/1134 flows in via the style fallback downstream.
    expect(para.formatting?.indentLeft).toBeUndefined();
    expect(para.formatting?.indentFirstLine).toBeUndefined();
  });

  test("numbering level ind still applies when the style chain defines none", () => {
    const para = parseStyledParagraph(
      '<w:pPr><w:pStyle w:val="NoIndentNumbered"/></w:pPr>',
      styles,
      numbering,
    );
    expect(para.formatting?.indentLeft).toBe(360);
    expect(para.formatting?.indentFirstLine).toBe(-360);
  });

  test("numbering level ind still applies for direct (non-style) numPr", () => {
    const root = parseXmlDocument(
      `<w:p ${W}><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr></w:p>`,
    ) as XmlElement | null;
    if (!root) {
      throw new Error("Failed to parse paragraph XML");
    }
    const para = parseParagraph(root, null, null, numbering, null, null);
    expect(para.formatting?.indentLeft).toBe(360);
  });

  test("style-attached numbering records numPrFromStyle provenance", () => {
    const para = parseStyledParagraph(
      '<w:pPr><w:pStyle w:val="AppBody-Claim"/></w:pPr>',
      styles,
      numbering,
    );
    expect(para.formatting?.numPr).toEqual({ numId: 2 });
    expect(para.formatting?.numPrFromStyle).toEqual({ numId: 2 });
  });

  test("direct numPr records no provenance", () => {
    const para = parseStyledParagraph(
      '<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr>',
      styles,
      numbering,
    );
    expect(para.formatting?.numPrFromStyle).toBeUndefined();
  });
});
