/**
 * Czech decisions read for their structure: the formula beside the title, the
 * lead-in and body of the operative part, and a section's numeral and title as
 * one heading, whichever court printed them and however its markup broke them.
 *
 * Every case is a document the publisher served, read by its court's parser.
 */

import { describe, expect, test } from "bun:test";

import type { Block, DocumentAst } from "@stll/legal-ast/document-ast";

import { PROCESSED_FIELD_EVIDENCE_READERS } from "@/api/tests/helpers/processed-field-evidence";

import { parseNsDecisionHtml } from "./cz-ns";
import { parseNssDecisionHtml } from "./cz-nss";
import { parseUsDecisionHtml } from "./cz-us";

const FIXTURES = new URL("__fixtures__/", import.meta.url);
const API_FIXTURES = "src/handlers/case-law/ingestion/parsers/__fixtures__/";

const gunzipText = async (name: string): Promise<string> =>
  new TextDecoder().decode(
    Bun.gunzipSync(await Bun.file(new URL(name, FIXTURES)).bytes()),
  );

const readRegional = async (name: string): Promise<DocumentAst> => {
  const [document, ...rest] = await PROCESSED_FIELD_EVIDENCE_READERS[
    "cz-regional"
  ](`${API_FIXTURES}cz-regional-${name}.finaldoc.json.gz`);
  expect(rest).toEqual([]);
  if (document === undefined) {
    throw new Error(`cz-regional-${name} holds no decision`);
  }
  return document.ast;
};

const readNs = async (name: string): Promise<DocumentAst> =>
  parseNsDecisionHtml({
    documentId: name,
    webUrl: name,
    printUrl: name,
    webHtml: "",
    printHtml: await gunzipText(`cz-ns-${name}.print.html.gz`),
  }).documentAst;

const readNss = async (name: string): Promise<DocumentAst> =>
  parseNssDecisionHtml({
    caseNumber: name,
    ecli: undefined,
    court: "Nejvyšší správní soud",
    decisionDate: undefined,
    decisionType: undefined,
    sourceUrl: undefined,
    html: await gunzipText(`cz-nss-${name}.html.gz`),
    detailMetadata: {},
  }).documentAst;

const readPlenary = async (name: string): Promise<DocumentAst> =>
  parseUsDecisionHtml({
    html: await gunzipText(`cz-plenary-${name}.html.gz`),
    caseNumber: name,
    ecli: undefined,
    court: "Ústavní soud",
    decisionDate: undefined,
    decisionType: "nález",
  }).documentAst;

const textOf = (block: Block): string => block.plainText;

const headingTexts = (ast: DocumentAst): string[] =>
  ast.blocks.flatMap((block) =>
    block.type === "heading" ? [block.plainText] : [],
  );

const titles = (ast: DocumentAst): string[] =>
  ast.blocks.flatMap((block) =>
    block.type === "heading" && block.role === "decision-title"
      ? [block.plainText]
      : [],
  );

const blockWithText = (ast: DocumentAst, text: string): Block | undefined =>
  ast.blocks.find((block) => block.plainText === text);

const holdings = (ast: DocumentAst): string[] =>
  ast.blocks.flatMap((block) =>
    block.type === "paragraph" && block.role === "holding"
      ? [block.plainText]
      : [],
  );

/** The formula and the lead-in are the court's wording, not sections. */
const expectOpeningFormula = (ast: DocumentAst): void => {
  expect(titles(ast)).not.toContain("JMÉNEM REPUBLIKY");
  expect(blockWithText(ast, "JMÉNEM REPUBLIKY")).toMatchObject({
    type: "paragraph",
    role: "intro",
  });
};

describe("letter-spaced words inside a sentence", () => {
  test("regional court: a word the court spaced unevenly is read as the word", async () => {
    const ast = await readRegional("12-c-94-2023");
    const texts = ast.blocks.map(textOf);

    expect(texts.some((text) => /m ů že/u.test(text))).toBe(false);
    expect(
      texts.some((text) =>
        text.includes(
          "Nesplní-li povinný dobrovolně co mu ukládá toto vykonatelné rozhodnutí, může oprávněný podat návrh",
        ),
      ),
    ).toBe(true);
  });
});

describe("the formula and the lead-in to the operative part", () => {
  test("regional court: the formula is intro, the title stands alone, takto: is no heading", async () => {
    const ast = await readRegional("20-co-186-2026");

    expect(titles(ast)).toEqual(["ROZSUDEK"]);
    expectOpeningFormula(ast);
    expect(headingTexts(ast)).not.toContain("takto:");
    expect(blockWithText(ast, "takto:")).toMatchObject({
      type: "paragraph",
      role: "intro",
    });
  });

  test("regional court: the operative items stay holdings between takto: and the reasons", async () => {
    const ast = await readRegional("20-co-186-2026");
    const taktoAt = ast.blocks.findIndex(
      ({ plainText }) => plainText === "takto:",
    );
    const reasonsAt = ast.blocks.findIndex(
      ({ plainText }) => plainText === "Odůvodnění:",
    );

    expect(taktoAt).toBeGreaterThan(0);
    expect(reasonsAt).toBeGreaterThan(taktoAt);
    expect(
      ast.blocks
        .slice(taktoAt + 1, reasonsAt)
        .every(
          (block) => block.type === "paragraph" && block.role === "holding",
        ),
    ).toBe(true);
  });

  test("Nejvyšší soud: the state and the formula under the title are intro, the title is the only title", async () => {
    const ast = await readNs("30-cdo-5117-2017");

    expect(titles(ast)).toEqual(["ROZSUDEK"]);
    expectOpeningFormula(ast);
    expect(blockWithText(ast, "ČESKÁ REPUBLIKA")).toMatchObject({
      type: "paragraph",
      role: "intro",
    });
  });

  test("Nejvyšší správní soud: the formula is intro, takto: is no heading", async () => {
    const ast = await readNss("10-afs-36-2026");

    expect(titles(ast)).toEqual(["ROZSUDEK"]);
    expectOpeningFormula(ast);
    expect(headingTexts(ast)).not.toContain("takto:");
    expect(blockWithText(ast, "takto:")).toMatchObject({
      type: "paragraph",
      role: "intro",
    });
  });
});

describe("a section's numeral and title are one heading", () => {
  test("Nejvyšší soud: numerals set on a line of their own join their titles", async () => {
    const ast = await readNs("8-tdo-245-2026");

    expect(headingTexts(ast)).toEqual(
      expect.arrayContaining([
        "I. Dovolání a vyjádření k němu",
        "II. Přípustnost dovolání",
        "III. Důvodnost dovolání",
      ]),
    );
    expect(headingTexts(ast).filter((text) => text.includes("\n"))).toEqual([]);
    for (const block of ast.blocks) {
      if (block.type === "heading") {
        expect(block.plainText).not.toMatch(/^[IVX]+\.$/u);
      }
    }
  });

  test("Nejvyšší soud: the reasons heading and the first section heading are two headings", async () => {
    const ast = await readNs("30-cdo-5117-2017");

    expect(blockWithText(ast, "Odůvodnění:")).toMatchObject({
      type: "heading",
      role: "section-heading",
    });
    expect(blockWithText(ast, "I. Dosavadní průběh řízení")).toMatchObject({
      type: "heading",
      level: 3,
    });
    expect(headingTexts(ast).filter((text) => text.includes("\n"))).toEqual([]);
  });

  test("Nejvyšší soud: the docket stays the docket, the sheet number stays in the caption", async () => {
    const ast = await readNs("30-cdo-5117-2017");

    expect(
      ast.blocks.find(
        (block) => block.type === "paragraph" && block.role === "case-number",
      )?.plainText,
    ).toBe("30 Cdo 5117/2017-191");
    expect(
      parseNsDecisionHtml({
        documentId: "30-cdo-5117-2017",
        webUrl: "30-cdo-5117-2017",
        printUrl: "30-cdo-5117-2017",
        webHtml: "",
        printHtml: await gunzipText("cz-ns-30-cdo-5117-2017.print.html.gz"),
      }).metadata.caseNumber,
    ).toBe("30 Cdo 5117/2017");
  });

  test("Nejvyšší správní soud: centred numbered list items are section headings, not paragraphs", async () => {
    const ast = await readNss("10-afs-36-2026");
    const sections = [
      "1. Vymezení věci",
      "2. Kasační stížnost a vyjádření žalovaného",
      "3. Posouzení věci",
      "4. Závěr a náklady řízení",
    ];

    for (const section of sections) {
      expect(blockWithText(ast, section)).toMatchObject({
        type: "heading",
        level: 3,
      });
    }
    expect(
      ast.blocks.filter(
        (block) =>
          block.type === "paragraph" && sections.includes(block.plainText),
      ),
    ).toEqual([]);
  });
});

describe("the operative part of a plenary nález", () => {
  test("is the holding under a Výrok label, with the bench sentence as intro", async () => {
    const ast = await readPlenary("pl-us-29-11");

    expect(blockWithText(ast, "Výrok")).toMatchObject({
      type: "heading",
      role: "section-heading",
    });
    expect(holdings(ast)).toEqual([
      "Ustanovení § 237 odst. 1 písm. c) zákona č. 99/1963 Sb., občanský soudní řád, ve znění pozdějších předpisů, se ruší uplynutím dne 31. 12. 2012.",
    ]);
    expect(
      ast.blocks.find((block) =>
        block.plainText.startsWith("pléna Ústavního soudu"),
      ),
    ).toMatchObject({ type: "paragraph", role: "intro" });
  });

  test("is the holding when the bench sentence is followed by it directly", async () => {
    const ast = await readPlenary("pl-us-18-15");

    expect(holdings(ast)).toEqual([
      "Ustanovení § 4 odst. 3 zákona č. 586/1992 Sb., o daních z příjmů, ve znění pozdějších předpisů, se ruší dnem vyhlášení tohoto nálezu ve Sbírce zákonů.",
    ]);
  });
});
