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
} from "@/api/handlers/case-law/document-ast";
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

  test("text the parse does not carry fails the parse rather than publishing less", () => {
    // A footnote whose text sits outside any `xText`: the note reader reads
    // `xText` alone, the validator reads the source, and the gap is an error.
    const parsed = parseXml(
      decision(
        '<xGlosses><xGloss xID="[1]" xBookmark="g1">przypis zapisany poza elementem tekstu, który musi przetrwać</xGloss></xGlosses>',
      ),
    );
    expect(Result.isError(parsed)).toBe(true);
  });
});
