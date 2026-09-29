import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { parsePlUodoDecisionXml, plUodoSourceTexts } from "./pl-uodo";

const parse = (body: string) => {
  const result = parsePlUodoDecisionXml({
    xml: `<xPart><xName>Decyzja</xName>${body}</xPart>`,
    documentId: "x",
    caseNumber: "x",
    court: "x",
    decisionDate: undefined,
    decisionType: undefined,
    sourceUrl: undefined,
  });
  if (Result.isError(result)) {
    throw result.error;
  }
  return result.value;
};

describe("source children outside the usual UODO structure", () => {
  test("#1: every child of a block survives in document order and is reported", () => {
    const parsed = parse(`<xBlock>
      <xUnit><xText>pierwszy tekst</xText></xUnit>
      <xText>tekst bez jednostki</xText>tekst bez elementu
      <xUnknown>tekst nowego elementu</xUnknown>
      <xUnit><xText>ostatni tekst</xText></xUnit>
    </xBlock>`);
    expect(parsed.documentAst.blocks.map((block) => block.plainText)).toEqual([
      "Decyzja",
      "pierwszy tekst",
      "tekst bez jednostki",
      "tekst bez elementu",
      "tekst nowego elementu",
      "ostatni tekst",
    ]);
    expect(parsed.unmappedMarkup).toEqual(["xText", "#text", "xUnknown"]);
    expect(parsed.validationIssues).toEqual([]);
  });

  test("#5: stray children in gloss containers and glosses keep their text", () => {
    const parsed = parse(`<xGlosses>
      <xExtra>tekst przed przypisem</xExtra>tekst poza przypisem
      <xText>tekst pod zbiorem</xText>
      <xGloss xID="[1]" xBookmark="g1">
        <xText>pierwsze zdanie przypisu</xText>
        <xUnknown>nieznany element przypisu</xUnknown>tekst bez elementu przypisu
        <![CDATA[tekst cdata przypisu]]>
        <xText>ostatnie zdanie przypisu</xText>
      </xGloss>
    </xGlosses>`);
    expect(parsed.documentAst.blocks.map((block) => block.plainText)).toEqual([
      "Decyzja",
      "tekst przed przypisem",
      "tekst poza przypisem",
      "tekst pod zbiorem",
      "pierwsze zdanie przypisu",
      "nieznany element przypisu",
      "tekst bez elementu przypisu",
      "tekst cdata przypisu",
      "ostatnie zdanie przypisu",
    ]);
    expect(parsed.unmappedMarkup).toEqual([
      "xExtra",
      "#text",
      "xText",
      "xUnknown",
      "#cdata",
    ]);
    expect(
      parsed.documentAst.blocks
        .slice(-5)
        .every(
          (block) => block.type === "paragraph" && block.note?.label === "[1]",
        ),
    ).toBe(true);
  });

  test("#15: root text, CDATA and repeated unit names and titles survive and are reported", () => {
    const xml = `tekst korzenia<![CDATA[tekst cdata korzenia]]>
      <xBlock><xUnit><xName>1</xName><xName>druga nazwa</xName>
        <xTitle>pierwszy tytuł</xTitle><xTitle>drugi tytuł</xTitle>
        <xText>tekst jednostki</xText>
      </xUnit></xBlock>`;
    const parsed = parse(xml);
    expect(parsed.documentAst.blocks.map((block) => block.plainText)).toEqual([
      "Decyzja",
      "tekst korzenia",
      "tekst cdata korzenia",
      "1 pierwszy tytuł",
      "druga nazwa",
      "drugi tytuł",
      "tekst jednostki",
    ]);
    expect(parsed.unmappedMarkup).toEqual([
      "#text",
      "#cdata",
      "xName",
      "xTitle",
    ]);
    const measured = plUodoSourceTexts(`<xPart>${xml}</xPart>`);
    for (const text of [
      "tekst korzenia",
      "tekst cdata korzenia",
      "druga nazwa",
      "drugi tytuł",
    ]) {
      expect(measured).toContain(text);
    }
  });

  test("whitespace-only children produce neither paragraphs nor text warnings", () => {
    const parsed = parse(` \n <![CDATA[ \n ]]><xBlock> \n </xBlock><xGlosses>
      <xGloss> \n <![CDATA[ \n ]]><xText> \n </xText></xGloss>
    </xGlosses>`);
    expect(parsed.documentAst.blocks.map((block) => block.plainText)).toEqual([
      "Decyzja",
    ]);
    expect(parsed.unmappedMarkup).toEqual([]);
  });
});
