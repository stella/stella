/**
 * The authority's decision XML, read against bodies the portal served.
 *
 * Both fixtures are captured verbatim with a provenance sidecar. What the
 * assertions check against is the XML itself, read here by a walk of its own
 * over every `xText` rather than through the parser, so the parser is
 * measured against the source and not against its own reading of it.
 */

import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import * as cheerio from "cheerio";
import { type AnyNode, isTag, isText } from "domhandler";

import type {
  Block,
  Inline,
  ParagraphBlock,
} from "@stll/legal-ast/document-ast";

import {
  parsePlUodoDecisionXml,
  plUodoSourceTexts,
} from "@/api/handlers/case-law/ingestion/parsers/pl-uodo";
import type { ParsePlUodoDecisionOutput } from "@/api/handlers/case-law/ingestion/parsers/pl-uodo";

const SHORT_DECISION = new URL(
  "__fixtures__/pl-uodo-zsoss-440-82-2019.xml",
  import.meta.url,
);
const LONG_DECISION = new URL(
  "__fixtures__/pl-uodo-dkn-5131-45-2022.xml",
  import.meta.url,
);

const parse = async (fixture: URL): Promise<ParsePlUodoDecisionOutput> => {
  const parsed = parsePlUodoDecisionXml({
    xml: await Bun.file(fixture).text(),
    documentId: "urn:ndoc:gov:pl:uodo:test",
    caseNumber: "test",
    court: "Prezes Urzędu Ochrony Danych Osobowych",
    decisionDate: undefined,
    decisionType: "decyzja",
    sourceUrl: undefined,
  });
  if (Result.isError(parsed)) {
    throw parsed.error;
  }
  return parsed.value;
};

const paragraphs = (blocks: readonly Block[]): ParagraphBlock[] =>
  blocks.filter((block): block is ParagraphBlock => block.type === "paragraph");

/**
 * Every `<xText>` of the source as the portal prints it: a footnote mark as
 * its label, other markup dropped, whitespace collapsed.
 */
const xTextsOf = (xml: string, withFootnoteMarks: boolean): string[] => {
  const $ = cheerio.load(xml, { xml: true });
  const labels = new Map(
    $("xGloss")
      .toArray()
      .map((gloss) => [gloss.attribs["xBookmark"], gloss.attribs["xID"]]),
  );
  const textOf = (node: AnyNode): string => {
    if (isText(node)) {
      return node.data;
    }
    if (!isTag(node)) {
      return "";
    }
    if (node.tagName === "xGlossRef") {
      return withFootnoteMarks ? (labels.get(node.attribs["xRef"]) ?? "") : "";
    }
    return node.children.map(textOf).join("");
  };
  return $("xText")
    .toArray()
    .map((element) => textOf(element).replace(/\s+/gu, " ").trim())
    .filter((text) => text.length > 0);
};

const sourceTexts = (xml: string): string[] => xTextsOf(xml, true);

/** Every inline of the document, containers and their children alike. */
const allInlines = (blocks: readonly Block[]): Inline[] => {
  const found: Inline[] = [];
  const walk = (inlines: readonly Inline[]): void => {
    for (const inline of inlines) {
      found.push(inline);
      if ("children" in inline) {
        walk(inline.children);
      }
    }
  };
  for (const block of blocks) {
    if ("inlines" in block) {
      walk(block.inlines);
    }
  }
  return found;
};

const citationsOf = (blocks: readonly Block[]): string[] =>
  allInlines(blocks).flatMap((inline) =>
    inline.type === "citation" ? [inline.cite] : [],
  );

const footnoteMarksOf = (blocks: readonly Block[]): string[] =>
  allInlines(blocks).flatMap((inline) =>
    inline.type === "superscript"
      ? [
          inline.children
            .map((child) => (child.type === "text" ? child.text : ""))
            .join(""),
        ]
      : [],
  );

describe("a short decision", () => {
  test("reads as the portal prints it: form, file mark, operative part, reasons", async () => {
    const { documentAst } = await parse(SHORT_DECISION);
    const [title, fileMark] = documentAst.blocks;

    expect(title).toMatchObject({
      type: "heading",
      role: "decision-title",
      plainText: "Decyzja",
    });
    expect(fileMark).toMatchObject({
      type: "paragraph",
      role: "case-number",
      plainText: "ZSOŚS.440.82.2019",
    });

    const reasonsAt = documentAst.blocks.findIndex(
      (block) => block.type === "heading" && block.plainText === "Uzasadnienie",
    );
    expect(reasonsAt).toBeGreaterThan(2);
    const operative = paragraphs(documentAst.blocks.slice(2, reasonsAt));
    expect(operative.every((block) => block.role === "holding")).toBe(true);
    expect(operative.at(-1)?.plainText).toBe("umarzam postępowanie");
    expect(
      paragraphs(documentAst.blocks.slice(reasonsAt)).some(
        (block) => block.role === "holding",
      ),
    ).toBe(false);
  });

  test("keeps every text the source prints, in order", async () => {
    const xml = await Bun.file(SHORT_DECISION).text();
    const { fulltext, validationIssues } = await parse(SHORT_DECISION);

    let from = 0;
    for (const text of sourceTexts(xml)) {
      const at = fulltext.indexOf(text, from);
      expect(at, text.slice(0, 60)).toBeGreaterThanOrEqual(0);
      from = at + text.length;
    }
    expect(validationIssues).toEqual([]);
  });

  test("an enumerated point opens with the marker the source prints", async () => {
    const { documentAst } = await parse(SHORT_DECISION);
    const points = paragraphs(documentAst.blocks).filter(
      (block) => block.listDepth === 1,
    );
    expect(points.map((block) => block.plainText.slice(0, 3))).toEqual([
      "1) ",
      "2) ",
    ]);
  });

  test("the publisher's links stay citations of what they print", async () => {
    const { documentAst } = await parse(SHORT_DECISION);
    const cites = citationsOf(documentAst.blocks);
    expect(cites).toContain("II OSK 1393/09");
    expect(cites).toContain("Dz. U. z 2019 r. poz. 125");
  });
});

describe("a long decision", () => {
  test("footnotes close the document under the labels the source gives them", async () => {
    const { documentAst } = await parse(LONG_DECISION);
    const notes = paragraphs(documentAst.blocks).filter(
      (block) => block.note !== undefined,
    );
    expect(notes.map((block) => block.note?.label)).toEqual([
      "[1]",
      "[2]",
      "[3]",
      "[4]",
    ]);
    expect(documentAst.blocks.slice(-notes.length)).toEqual(notes);
    // Each is referenced where the text cites it.
    expect(footnoteMarksOf(documentAst.blocks)).toEqual([
      "[1]",
      "[2]",
      "[3]",
      "[4]",
    ]);
  });

  test("a quoted passage is a quotation, opening with the source's mark", async () => {
    const { documentAst } = await parse(LONG_DECISION);
    const quoted = paragraphs(documentAst.blocks).filter(
      (block) => block.role === "quote",
    );
    expect(quoted).toHaveLength(4);
    expect(quoted[0]?.plainText.startsWith("„W przedmiotowej sprawie")).toBe(
      true,
    );
  });

  test("points inside points sit a level deeper", async () => {
    const { documentAst } = await parse(LONG_DECISION);
    const operative = paragraphs(documentAst.blocks).filter(
      (block) => block.role === "holding",
    );
    expect(
      operative.map((block) => [block.listDepth, block.plainText.slice(0, 3)]),
    ).toContainEqual([2, "a) "]);
  });

  test("keeps every text the source prints", async () => {
    const xml = await Bun.file(LONG_DECISION).text();
    const { fulltext, validationIssues } = await parse(LONG_DECISION);
    const missing = sourceTexts(xml).filter((text) => !fulltext.includes(text));
    expect(missing).toEqual([]);
    expect(validationIssues).toEqual([]);
  });
});

test("a payload that is not the portal's decision XML is an error, not an empty decision", () => {
  const parsed = parsePlUodoDecisionXml({
    xml: "<html><body>Nie znaleziono</body></html>",
    documentId: "x",
    caseNumber: "x",
    court: "x",
    decisionDate: undefined,
    decisionType: undefined,
    sourceUrl: undefined,
  });
  expect(Result.isError(parsed)).toBe(true);
});

describe("what the parse is measured against", () => {
  test("the validator's text is read from the XML, not from the parsed blocks", async () => {
    const xml = await Bun.file(LONG_DECISION).text();
    // The XML's own texts, markup dropped, with no footnote labels: the
    // labels are the parse's addition, and the source prints none inline.
    const fromSource = xTextsOf(xml, false);

    const measured = plUodoSourceTexts(xml);
    for (const text of fromSource) {
      expect(measured).toContain(text);
    }
  });

  test("a text in an element this reader has no rule for is kept, and measured", () => {
    const xml = `<?xml version='1.0' encoding='UTF-8'?>
<xPart xml:space="preserve"><xName>Decyzja</xName><xTitle>DKN.1.1.2025</xTitle>
<xBlock><xUnit xIsTitle="true" xType="bran"><xName> </xName><xTitle> </xTitle>
<xUnit xType="none"><xName> </xName><xText>nakłada karę pieniężną</xText>
<xNote><xText>zdanie w elemencie bez reguły</xText></xNote></xUnit>
</xUnit></xBlock></xPart>`;
    const parsed = parsePlUodoDecisionXml({
      xml,
      documentId: "x",
      caseNumber: "DKN.1.1.2025",
      court: "x",
      decisionDate: undefined,
      decisionType: undefined,
      sourceUrl: undefined,
    });
    expect(Result.isOk(parsed)).toBe(true);
    if (Result.isError(parsed)) {
      return;
    }
    expect(parsed.value.fulltext).toContain("zdanie w elemencie bez reguły");
    expect(plUodoSourceTexts(xml)).toContain("zdanie w elemencie bez reguły");
    expect(parsed.value.validationIssues).toEqual([]);
  });
});

describe("publisher emphasis", () => {
  test("a quoted term the portal sets in italics stays italic", async () => {
    const { documentAst } = await parse(SHORT_DECISION);
    const italics = allInlines(documentAst.blocks).flatMap((inline) =>
      inline.type === "italic"
        ? [
            inline.children
              .map((child) => (child.type === "text" ? child.text : ""))
              .join(""),
          ]
        : [],
    );
    // `<xCx>„UODO”</xCx>`, which the portal renders as `<i>„UODO”</i>`.
    expect(italics).toContain("„UODO”");
    expect(italics).toContain("„Skarżący”");
  });
});

describe("containers and text this reader has no rule for", () => {
  const parseBody = (body: string) => {
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

  test("a marker-only unit is retained before its nested units", () => {
    const parsed = parseBody(`<xBlock>
      <xUnit xType="pass"><xName xSffx=")">1</xName>
        <xUnit xType="pass"><xName xSffx=")">a</xName><xText>child text</xText></xUnit>
      </xUnit>
      <xUnit xType="pass"><xName xSffx=")">2</xName><xTitle>Second</xTitle>
        <xUnit xType="pass"><xName xSffx=")">a</xName><xText>nested heading child</xText></xUnit>
      </xUnit>
      <xUnit><xName xSffx=")">3</xName><xText>   </xText></xUnit>
      <xUnit><xText>unmarked text</xText></xUnit>
    </xBlock>`);
    expect(parsed.documentAst.blocks.map((block) => block.plainText)).toEqual([
      "Decyzja",
      "1) ",
      "a) child text",
      "2) Second",
      "a) nested heading child",
      "3) ",
      "unmarked text",
    ]);
    expect(parsed.documentAst.blocks.slice(1, 3)).toMatchObject([
      { type: "paragraph", listDepth: 1 },
      { type: "paragraph", listDepth: 2 },
    ]);
    expect(parsed.documentAst.blocks.at(3)).toMatchObject({
      type: "heading",
      plainText: "2) Second",
    });
    expect(parsed.validationIssues).toEqual([]);
  });

  test.each(["root", "unit"])(
    "unknown wrappers at the %s keep nested units, markers and separate paragraphs",
    (position) => {
      const wrapper =
        '<xUnknown><xUnit xType="pass"><xName xSffx=")">1</xName><xText>Alpha words</xText><xText>Beta words</xText></xUnit><xUnit xType="pass"><xName xSffx=".">2</xName><xTitle>Gamma heading</xTitle><xText>Delta words</xText></xUnit></xUnknown>';
      const parsed = parseBody(
        position === "root"
          ? wrapper
          : `<xBlock><xUnit>${wrapper}</xUnit></xBlock>`,
      );
      expect(parsed.documentAst.blocks.map((block) => block.plainText)).toEqual(
        [
          "Decyzja",
          "1) Alpha words",
          "Beta words",
          "2. Gamma heading",
          "Delta words",
        ],
      );
      expect(parsed.documentAst.blocks.at(3)?.type).toBe("heading");
      expect(parsed.documentAst.blocks.at(1)).toMatchObject({
        type: "paragraph",
        listDepth: 1,
      });
      expect(parsed.unmappedMarkup).toEqual(["xUnknown"]);
      expect(parsed.validationIssues).toEqual([]);
    },
  );

  test("root text elements are retained and reported", () => {
    const parsed = parseBody("<xText>Alpha words</xText>");
    expect(parsed.documentAst.blocks.map((block) => block.plainText)).toEqual([
      "Decyzja",
      "Alpha words",
    ]);
    expect(parsed.unmappedMarkup).toEqual(["xText"]);
  });
  test("every child of a block survives in document order and is reported", () => {
    const parsed = parseBody(`<xBlock>
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

  test("stray children in gloss containers and glosses keep their text", () => {
    const parsed = parseBody(`<xGlosses>
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

  test("root text, CDATA and repeated unit names and titles survive and are reported", () => {
    const xml = `tekst korzenia<![CDATA[tekst cdata korzenia]]>
      <xBlock><xUnit><xName>1</xName><xName>druga nazwa</xName>
        <xTitle>pierwszy tytuł</xTitle><xTitle>drugi tytuł</xTitle>
        <xText>tekst jednostki</xText>
      </xUnit></xBlock>`;
    const parsed = parseBody(xml);
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
    const parsed =
      parseBody(` \n <![CDATA[ \n ]]><xBlock> \n </xBlock><xGlosses>
      <xGloss> \n <![CDATA[ \n ]]><xText> \n </xText></xGloss>
    </xGlosses>`);
    expect(parsed.documentAst.blocks.map((block) => block.plainText)).toEqual([
      "Decyzja",
    ]);
    expect(parsed.unmappedMarkup).toEqual([]);
  });
  const parseXml = (xml: string) =>
    parsePlUodoDecisionXml({
      xml,
      documentId: "x",
      caseNumber: "DKN.1.1.2025",
      court: "x",
      decisionDate: undefined,
      decisionType: undefined,
      sourceUrl: undefined,
    });

  const decision = (
    extra: string,
  ): string => `<?xml version='1.0' encoding='UTF-8'?>
<xPart xml:space="preserve"><xName>Decyzja</xName><xTitle>DKN.1.1.2025</xTitle>
<xBlock><xUnit xIsTitle="true" xType="bran"><xName> </xName><xTitle> </xTitle>
<xUnit xType="none"><xName> </xName><xText>nakłada na administratora karę pieniężną</xText></xUnit>
</xUnit></xBlock>${extra}</xPart>`;

  test("a container the portal adds beside the body is read, not dropped", () => {
    const parsed = parseXml(
      decision(
        "<xAnnex><xText>pouczenie o prawie wniesienia skargi do sądu</xText></xAnnex>",
      ),
    );
    expect(Result.isOk(parsed) && parsed.value.fulltext).toContain(
      "pouczenie o prawie wniesienia skargi do sądu",
    );
  });

  test("text outside a footnote text element is preserved and reported", () => {
    // The source can leave footnote text outside its usual text element.
    const parsed = parseXml(
      decision(
        '<xGlosses><xGloss xID="[1]" xBookmark="g1">przypis zapisany poza elementem tekstu, który musi przetrwać</xGloss></xGlosses>',
      ),
    );
    expect(Result.isOk(parsed)).toBe(true);
    if (Result.isError(parsed)) {
      throw parsed.error;
    }
    expect(parsed.value.fulltext).toContain(
      "przypis zapisany poza elementem tekstu, który musi przetrwać",
    );
    expect(parsed.value.unmappedMarkup).toContain("#text");
  });
});
