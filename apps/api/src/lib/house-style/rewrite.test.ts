import { describe, expect, test } from "bun:test";
import * as slimdom from "slimdom";

import { W_NS } from "@/api/lib/docx/ooxml";
import {
  COMMENTS_XML,
  CONTAINER_DOCUMENT_XML,
  CORE_PROPERTIES_XML,
  HOUSE_DOCUMENT_XML,
  HOUSE_STYLES_XML,
  SOURCE_DOCUMENT_XML,
} from "@/api/lib/house-style/__fixtures__/synthetic-style-set";
import { attr, childElement } from "@/api/lib/house-style/catalogue";
import {
  readBodyParagraphs,
  stripManualMarker,
} from "@/api/lib/house-style/paragraphs";
import {
  buildConvertedBody,
  collectDefinedStyleIds,
  collectReferencedStyleIds,
  emptyRootChildren,
  emptyXmlElements,
  stripNotes,
  stripPartText,
} from "@/api/lib/house-style/rewrite";

const KNOWN = collectDefinedStyleIds(HOUSE_STYLES_XML);

const convert = (
  styleByIndex: ReadonlyMap<number, string>,
  numbered: ReadonlySet<string> = new Set(["Heading1Firm", "Heading2Firm"]),
) =>
  buildConvertedBody({
    houseDocumentXml: HOUSE_DOCUMENT_XML,
    sourceDocumentXml: SOURCE_DOCUMENT_XML,
    styleByIndex,
    fallbackStyleId: "Normal",
    numberedStyleIds: numbered,
    knownStyleIds: KNOWN,
  });

const ASSIGNED = new Map([
  [0, "CentredFirm"],
  [1, "Heading1Firm"],
  [2, "DefinitionFirm"],
  [3, "Heading2Firm"],
  [4, "CentredFirm"],
  [5, "Bodytext1Firm"],
]);

const paragraphsOf = (xml: string): slimdom.Element[] =>
  slimdom.parseXmlDocument(xml).getElementsByTagNameNS(W_NS, "p");

const nth = (paragraphs: slimdom.Element[], index: number): slimdom.Element => {
  const found = paragraphs.at(index);
  if (found === undefined) {
    throw new Error(`the converted body has no paragraph ${String(index)}`);
  }
  return found;
};

const styleOf = (paragraph: slimdom.Element): string | null => {
  const pPr = childElement(paragraph, "pPr");
  const pStyle = pPr === null ? null : childElement(pPr, "pStyle");
  return pStyle === null ? null : attr(pStyle, "val");
};

const textOf = (paragraph: slimdom.Element): string =>
  paragraph
    .getElementsByTagNameNS(W_NS, "t")
    .map((element) => element.textContent ?? "")
    .join("");

describe("the converted body", () => {
  const converted = convert(ASSIGNED);
  const paragraphs = paragraphsOf(converted.xml);

  test("gives every paragraph the style it was decided", () => {
    expect(paragraphs.map(styleOf)).toEqual([
      "CentredFirm",
      "Heading1Firm",
      "DefinitionFirm",
      "Heading2Firm",
      "CentredFirm",
      "Bodytext1Firm",
      "Normal",
    ]);
  });

  test("names no style the style set does not define", () => {
    const defined = collectDefinedStyleIds(HOUSE_STYLES_XML);
    for (const id of collectReferencedStyleIds(converted.xml)) {
      expect(defined.has(id)).toBe(true);
    }
  });

  test("drops the source's own numbering and direct paragraph formatting", () => {
    expect(converted.xml).not.toContain("w:numPr");
    expect(converted.xml).not.toContain("w:ind");
    expect(converted.xml).not.toContain("w:jc");
  });

  test("keeps the emphasis a reader put in and drops the rest", () => {
    expect(converted.xml).toContain("<w:i/>");
    expect(converted.xml).not.toContain("w:color");
  });

  test("keeps the style set's own section properties", () => {
    expect(converted.xml).toContain('w:w="11906"');
    expect(converted.xml).not.toContain('w:w="12240"');
  });

  test("drops an empty paragraph but keeps the one a table cell needs", () => {
    expect(converted.droppedEmptyParagraphs).toBe(1);
    expect(styleOf(nth(paragraphs, -1))).toBe("Normal");
    expect(converted.xml).toContain("w:tbl");
  });

  test("removes a typed number where the house style numbers itself", () => {
    expect(textOf(nth(paragraphs, 3))).toBe(
      "The Lender shall advance the Loan.",
    );
    expect(converted.strippedManualMarkers).toBe(2);
  });

  test("removes a marker typed across two runs", () => {
    const split = buildConvertedBody({
      houseDocumentXml: HOUSE_DOCUMENT_XML,
      sourceDocumentXml: `<w:document xmlns:w="${W_NS}"><w:body><w:p><w:r><w:t xml:space="preserve">2.</w:t></w:r><w:r><w:t xml:space="preserve">1 The Lender shall advance the Loan.</w:t></w:r></w:p></w:body></w:document>`,
      styleByIndex: new Map([[0, "Heading2Firm"]]),
      fallbackStyleId: "Normal",
      numberedStyleIds: new Set(["Heading2Firm"]),
      knownStyleIds: KNOWN,
    });
    expect(textOf(nth(paragraphsOf(split.xml), 0))).toBe(
      "The Lender shall advance the Loan.",
    );
    expect(split.strippedManualMarkers).toBe(1);
  });

  test("keeps a typed number where the house style prints none", () => {
    const unnumbered = convert(ASSIGNED, new Set());
    expect(textOf(nth(paragraphsOf(unnumbered.xml), 3))).toBe(
      "2.1 The Lender shall advance the Loan.",
    );
    expect(unnumbered.strippedManualMarkers).toBe(0);
  });

  test("falls back to plain body text for a paragraph nothing decided", () => {
    const partial = convert(new Map([[0, "Heading1Firm"]]));
    expect(paragraphsOf(partial.xml).map(styleOf).slice(1)).toEqual([
      "Normal",
      "Normal",
      "Normal",
      "Normal",
      "Normal",
      "Normal",
    ]);
  });
});

describe("a document whose paragraphs sit in containers", () => {
  const decided = readBodyParagraphs(CONTAINER_DOCUMENT_XML).filter(
    ({ text }) => text.length > 0,
  );
  const converted = buildConvertedBody({
    houseDocumentXml: HOUSE_DOCUMENT_XML,
    sourceDocumentXml: CONTAINER_DOCUMENT_XML,
    styleByIndex: new Map(
      decided.map((_paragraph, index) => [index, "Bodytext1Firm"]),
    ),
    fallbackStyleId: "Normal",
    numberedStyleIds: new Set(),
    knownStyleIds: KNOWN,
  });
  const styleReferences = slimdom
    .parseXmlDocument(converted.xml)
    .getElementsByTagNameNS(W_NS, "pStyle");

  // The decision a paragraph was charged for is only worth what the rewrite
  // writes: one style reference per decided paragraph, whatever wraps it.
  test("writes one style for every paragraph it decided", () => {
    expect(decided).toHaveLength(5);
    expect(styleReferences).toHaveLength(decided.length);
  });

  test("keeps the text a container holds", () => {
    const text = paragraphsOf(converted.xml).map(textOf);
    expect(text).toEqual([
      "The parties have agreed as follows.",
      "A. The Borrower wishes to borrow.",
      "Party",
      "Registered office",
      "This paragraph carries a text box.",
    ]);
  });

  test("keeps the containers themselves", () => {
    expect(converted.xml).toContain("w:sdt");
    expect(
      slimdom
        .parseXmlDocument(converted.xml)
        .getElementsByTagNameNS(W_NS, "tbl"),
    ).toHaveLength(2);
  });

  test("drops an empty paragraph inside a container", () => {
    expect(converted.droppedEmptyParagraphs).toBe(1);
  });

  // A text box hangs off a run under VML, which a rebuilt paragraph does not
  // carry. Neither side of the conversion reaches it, so it is absent from
  // both the decisions and the output rather than paid for and then lost.
  test("neither decides nor writes a paragraph drawn in a text box", () => {
    expect(decided.map(({ text }) => text)).not.toContain(
      "Drawn in a text box",
    );
    expect(converted.xml).not.toContain("Drawn in a text box");
  });
});

describe("recognising a typed list marker", () => {
  test.each([
    ["1. Definitions", "1. ", "Definitions"],
    ["2.1 The Lender shall pay", "2.1 ", "The Lender shall pay"],
    ["(a) fails to pay", "(a) ", "fails to pay"],
    ["(iv) becomes insolvent", "(iv) ", "becomes insolvent"],
    ["(A) The Borrower wishes", "(A) ", "The Borrower wishes"],
    ["a) the rate", "a) ", "the rate"],
  ])("strips %p", (input, marker, rest) => {
    expect(stripManualMarker(input)).toEqual({ marker, text: rest });
  });

  test.each([
    ["2026 was the year of the agreement"],
    ["EUR 250,000 is advanced"],
    ["means a day banks are open"],
    ["1.2.3"],
  ])("leaves %p alone", (input) => {
    expect(stripManualMarker(input)).toEqual({ marker: "", text: input });
  });
});

describe("scrubbing what belonged to the style-set document", () => {
  test("empties a header's text and keeps its structure", () => {
    const header = `<w:hdr xmlns:w="${W_NS}"><w:p><w:r><w:t>A firm name</w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r></w:p></w:hdr>`;
    const stripped = stripPartText(header);
    expect(stripped).not.toContain("A firm name");
    expect(stripped).toContain("fldChar");
  });

  test("drops notes but keeps the separators Word requires", () => {
    const notes = `<w:footnotes xmlns:w="${W_NS}"><w:footnote w:type="separator" w:id="-1"><w:p/></w:footnote><w:footnote w:id="2"><w:p><w:r><w:t>A note</w:t></w:r></w:p></w:footnote></w:footnotes>`;
    const stripped = stripNotes(notes, "footnote");
    expect(stripped).toContain('w:type="separator"');
    expect(stripped).not.toContain("A note");
  });

  test("empties a comment store", () => {
    expect(emptyRootChildren(COMMENTS_XML)).not.toContain("An internal note");
    expect(emptyRootChildren(COMMENTS_XML)).toContain("w:comments");
  });

  test("empties the authorship in the document properties", () => {
    const scrubbed = emptyXmlElements(CORE_PROPERTIES_XML, [
      "dc:creator",
      "cp:lastModifiedBy",
    ]);
    expect(scrubbed).not.toContain("A Person");
    expect(scrubbed).not.toContain("Another Person");
    expect(scrubbed).toContain("dc:creator");
  });
});
