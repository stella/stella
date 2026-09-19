import { describe, expect, test } from "bun:test";

import {
  HOUSE_DOCUMENT_XML,
  HOUSE_NUMBERING_XML,
  HOUSE_STYLES_XML,
  SOURCE_DOCUMENT_XML,
} from "@/api/lib/house-style/__fixtures__/synthetic-style-set";
import { readStyleDefinitions } from "@/api/lib/house-style/catalogue";
import {
  extractParagraphFeatures,
  readBodyParagraphs,
} from "@/api/lib/house-style/paragraphs";
import type { ParagraphFeatures } from "@/api/lib/house-style/paragraphs";

const definitions = readStyleDefinitions({
  stylesXml: HOUSE_STYLES_XML,
  numberingXml: HOUSE_NUMBERING_XML,
});

const featuresOf = (documentXml: string): ParagraphFeatures[] =>
  extractParagraphFeatures({
    paragraphs: readBodyParagraphs(documentXml),
    definitions,
  });

const source = featuresOf(SOURCE_DOCUMENT_XML);

describe("the paragraphs a conversion decides", () => {
  test("skip empty paragraphs and number what is left in reading order", () => {
    expect(source.map((feature) => feature.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(source.at(0)?.text).toBe("SHORT-FORM LOAN AGREEMENT");
    expect(source.map((feature) => feature.text)).not.toContain("");
  });

  test("include a paragraph inside a table and say so", () => {
    const cell = source.at(-1);
    expect(cell?.text).toBe("Party");
    expect(cell?.inTable).toBe(true);
    expect(source.filter((feature) => feature.inTable)).toHaveLength(1);
  });

  test("call a paragraph bold only when every text run is bold", () => {
    expect(source.at(0)?.bold).toBe(true);
    expect(source.at(2)?.bold).toBe(false);
  });

  test("read centring from the paragraph's own properties", () => {
    expect(source.at(4)?.centred).toBe(true);
    expect(source.at(0)?.centred).toBe(false);
  });

  test("carry the neighbours on both sides, and nothing past the ends", () => {
    expect(source.at(1)?.previous?.text).toBe("SHORT-FORM LOAN AGREEMENT");
    expect(source.at(1)?.next?.text).toBe(
      "Business Day means a day other than a Saturday.",
    );
    expect(source.at(0)?.previous).toBeNull();
    expect(source.at(-1)?.next).toBeNull();
  });

  test("name the style a paragraph carried, its display name included", () => {
    const house = featuresOf(HOUSE_DOCUMENT_XML);
    const heading = house.find(
      (feature) => feature.text === "Definitions and interpretation",
    );
    expect(heading).toMatchObject({
      originalStyleId: "Heading1Firm",
      originalStyleName: "Heading 1 Firm",
      outlineLevel: 0,
      numberExample: "1.",
      allCaps: true,
    });
  });

  test("fall back to the document's default style where a paragraph names none", () => {
    expect(
      source.every((feature) => feature.originalStyleId === "Normal"),
    ).toBe(true);
  });

  // `w:numId` 0 on the paragraph switches its style's list off for this
  // paragraph; read as an absent `w:numPr` it would inherit that list back.
  test("read a paragraph's own numId 0 as unnumbered, not as silence", () => {
    const unnumbered = featuresOf(
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
        <w:p><w:pPr><w:pStyle w:val="DefinitionFirm"/><w:numPr><w:numId w:val="0"/></w:numPr></w:pPr><w:r><w:t>Not a definition</w:t></w:r></w:p>
      </w:body></w:document>`,
    );
    expect(unnumbered.at(0)).toMatchObject({
      originalStyleId: "DefinitionFirm",
      numberingLevel: null,
      numberFormat: null,
      numberExample: null,
    });
  });

  test("prefer a paragraph's own numbering over the style's", () => {
    const numbered = featuresOf(
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
        <w:p><w:pPr><w:pStyle w:val="Heading1Firm"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="3"/></w:numPr></w:pPr><w:r><w:t>Lettered instead</w:t></w:r></w:p>
      </w:body></w:document>`,
    );
    expect(numbered.at(0)).toMatchObject({
      numberFormat: "lowerLetter",
      numberExample: "(a)",
      outlineLevel: 0,
    });
  });
});
