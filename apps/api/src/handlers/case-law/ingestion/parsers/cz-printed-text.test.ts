/**
 * Recorded NSS, regional-court and Nejvyšší soud decisions read as the court
 * printed them: no page furniture in the text, sentences a page break cut read
 * whole, letter-spaced words as words, and the structure the court gave them.
 *
 * Every case is a document the publisher served, read by its court's parser.
 */

import { describe, expect, test } from "bun:test";

import type {
  Block,
  DocumentAst,
  ParagraphBlock,
} from "@stll/legal-ast/document-ast";

import { PROCESSED_FIELD_EVIDENCE_READERS } from "@/api/tests/helpers/processed-field-evidence";

import { parseNsDecisionHtml } from "./cz-ns";
import { parseNssDecisionHtml } from "./cz-nss";

const FIXTURES = new URL("__fixtures__/", import.meta.url);
const API_FIXTURES = "src/handlers/case-law/ingestion/parsers/__fixtures__/";

const gunzipText = async (name: string): Promise<string> =>
  new TextDecoder().decode(
    Bun.gunzipSync(await Bun.file(new URL(name, FIXTURES)).bytes()),
  );

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

const texts = (ast: DocumentAst): string[] =>
  ast.blocks.map((block) => block.plainText);

const paragraphs = (ast: DocumentAst): ParagraphBlock[] =>
  ast.blocks.filter(
    (block): block is ParagraphBlock => block.type === "paragraph",
  );

const headings = (ast: DocumentAst, level: number): string[] =>
  ast.blocks.flatMap((block) =>
    block.type === "heading" && block.level === level ? [block.plainText] : [],
  );

const numbersOf = (blocks: readonly Block[]): number[] =>
  blocks.flatMap((block) =>
    block.type === "paragraph" && block.number !== undefined
      ? [block.number]
      : [],
  );

const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, index) => from + index);

/** The one block holding `text`, which a cut sentence would not. */
const expectWhole = (ast: DocumentAst, text: string): void => {
  expect(
    texts(ast).filter((plainText) => plainText.includes(text)),
  ).toHaveLength(1);
};

describe("page furniture", () => {
  test("NSS: a regional court's running header between the halves of a sentence is gone", async () => {
    const ast = await readNss("52-a-35-2012");
    expect(texts(ast).filter((text) => /pokračování/iu.test(text))).toEqual([]);
    expectWhole(ast, "protože za jízdy po ul. Lipová v obci Vysoké Mýto");
    expectWhole(
      ast,
      "v usnesení ze dne 8.3.2011, č.j. 7 Azs 79/2009-84, dále judikoval",
    );
  });

  test("NSS: a paragraph cut at a page break reads as one", async () => {
    const ast = await readNss("2-afs-180-2004");
    expectWhole(ast, "přednostně aplikovat zákon č. 337/1992 Sb.");
    expectWhole(ast, "Toto zpochybnění se však netýká otázky rozhodné");
    expectWhole(ast, "V úvahu v tomto případě připadalo buď přijetí");
  });

  test("regional courts: running headers leave the reasoning, and the sentence they cut is whole", async () => {
    const ast = await readRegional("9-c-191-2025");
    expect(texts(ast).filter((text) => /pokračování/iu.test(text))).toEqual([]);
    expectWhole(ast, "dle ustanovení § 6 odst. 1, § 7, § 8 a § 11 vyhlášky");
  });

  test("Nejvyšší soud: running headers and bare page numbers leave the print page", async () => {
    const ast = await readNs("22-cdo-1717-2000");
    expect(
      texts(ast).filter(
        (text) => text.startsWith("Pokračování") || /^\d+$/u.test(text),
      ),
    ).toEqual([]);
    expectWhole(ast, "soudu prvního stupně z 19. 3. 1998 zrušil");
    expectWhole(ast, "představovaný opravárenskou firmou lze pak poznamenat");
  });

  test("Nejvyšší soud: the furniture above the first page leaves the docket and title in front", async () => {
    const ast = await readNs("22-cdo-4223-2018");
    expect(
      ast.blocks
        .slice(0, 2)
        .map((block) => [
          block.type === "paragraph" || block.type === "heading"
            ? block.role
            : undefined,
          block.plainText,
        ]),
    ).toEqual([
      ["case-number", "22 Cdo 4223/2018-137"],
      ["decision-title", "USNESENÍ"],
    ]);
  });

  test("soft hyphens leave the text", async () => {
    for (const ast of [
      await readNss("57-af-17-2023"),
      await readNs("30-cdo-1883-2013"),
    ]) {
      expect(texts(ast).filter((text) => text.includes("­"))).toEqual([]);
    }
  });
});

describe("letter-spaced words", () => {
  test("NSS: the wide gaps between spaced words stay word boundaries", async () => {
    expectWhole(
      await readNss("2-afs-180-2004"),
      "sp. zn. 31 Ca 51/2004, se zrušuje a věc se mu vrací k dalšímu řízení.",
    );
    const ast = await readNss("2-afs-154-2005");
    expect(
      paragraphs(ast)
        .filter((block) => block.role === "holding")
        .map((block) => block.plainText),
    ).toEqual([
      "I. Kasační stížnost se zamítá.",
      "II. Žalovanému se nepřiznává právo na náhradu nákladů řízení o kasační stížnosti.",
    ]);
    expectWhole(
      ast,
      "Poučení: Proti tomuto rozsudku nejsou opravné prostředky přípustné.",
    );
  });

  test("NSS: a spaced word whose first letter has its own wrapper is one word", async () => {
    expectWhole(
      await readNss("10-as-226-2019"),
      "Poučení: Proti tomuto rozsudku není opravný prostředek přípustný.",
    );
  });
});

describe("structure", () => {
  test("NSS: subsection headings with no space after the section numeral", async () => {
    expect(headings(await readNss("2-as-98-2026"), 4)).toEqual([
      "IV.1 Rozhodná právní úprava",
      "IV.2 Judikaturní vývoj pravidla „jeden stůl živé hry, jeden krupiér“",
      "IV.3 Rozsudek č. j. 7 As 260/2024‑42: pravidlo obsažené v základním povolení je přísnější než zákonná povinnost",
      "IV.4 Vztah zákonné povinnosti a podmínky základního povolení, která ji opakuje",
      "IV.5 Shrnutí a doplňující úvahy",
    ]);
    expect(headings(await readNss("9-as-264-2020-29"), 4)).toEqual([
      "III. a) Vymezení sporné právní otázky",
      "III. b) Právní názor osmého senátu",
      "III. c) Právní názor devátého senátu: účinná soudní ochrana",
      "III. d) Právní názor devátého senátu: škola není původcem zásahu",
      "III. e) Právní názor devátého senátu: základní škola zde nevystupuje jako správní orgán",
    ]);
  });

  test("NSS: paragraph numbers of a quoted decision are not the court's", async () => {
    const ast = await readNss("9-as-264-2020-29");
    expect(numbersOf(ast.blocks)).toEqual(range(1, 34));
    const quoted = paragraphs(ast).filter((block) =>
      block.plainText.startsWith("[118] Základní škola"),
    );
    expect(quoted).toHaveLength(1);
    expect(quoted[0]?.number).toBeUndefined();
  });

  test("NSS: each separate opinion is headed and numbered from 1", async () => {
    const ast = await readNss("9-as-264-2020-51");
    expect(
      headings(ast, 2).filter((heading) =>
        heading.startsWith("Odlišné stanovisko"),
      ),
    ).toEqual([
      "Odlišné stanovisko soudce Petra Mikeše dle § 55a soudního řádu správního k rozhodnutí rozšířeného senátu ze dne 30. 6. 2021 ve věci sp. zn. 9 As 264/2020",
      "Odlišné stanovisko soudce Karla Šimky dle § 55a soudního řádu správního k rozhodnutí rozšířeného senátu ze dne 30. 6. 2021 ve věci sp. zn. 9 As 264/2020",
    ]);
    const dissents = paragraphs(ast).filter(
      (block) => block.role === "dissent",
    );
    expect(numbersOf(dissents)).toEqual([...range(1, 21), ...range(1, 22)]);
    expect(
      numbersOf(paragraphs(ast).filter((block) => block.role === undefined)),
    ).toEqual(range(1, 86));
    expect(
      paragraphs(ast).filter((block) => /^\[\d+\]/u.test(block.plainText)),
    ).toEqual([]);
  });

  test("NSS: a decision set in a layout table reads paragraph by paragraph, with the list's numbers", async () => {
    const ast = await readNss("57-af-17-2023");
    expect(numbersOf(ast.blocks)).toEqual(range(1, 35));
    expect(
      paragraphs(ast)
        .filter((block) => block.role === "holding")
        .map((block) => block.plainText),
    ).toEqual([
      "I. Žaloba se zamítá.",
      "II. Žádný z účastníků řízení nemá právo na náhradu nákladů řízení.",
    ]);
    expectWhole(
      ast,
      "žalobce: | U. H. doručovací adresa X zastoupen Mgr. Libuší Hrůšovou, advokátkou sídlem Veverkova",
    );
  });

  test("regional courts: the title the header prints is the title, once", async () => {
    const ast = await readRegional("3-t-96-2026");
    expect(
      ast.blocks.flatMap((block) =>
        block.type === "heading" && block.role === "decision-title"
          ? [block.plainText]
          : [],
      ),
    ).toEqual(["ROZSUDEK"]);
    expect(
      ast.blocks.find((block) => block.plainText === "JMÉNEM REPUBLIKY"),
    ).toMatchObject({ type: "paragraph", role: "intro" });
  });

  test("Nejvyšší soud: a caption below the court's name is split into docket and title", async () => {
    const ast = await readNs("25-cdo-803-2003");
    expect(
      ast.blocks.flatMap((block) =>
        (block.type === "paragraph" && block.role === "case-number") ||
        (block.type === "heading" && block.role === "decision-title")
          ? [block.plainText]
          : [],
      ),
    ).toEqual(["25 Cdo 803/2003", "ROZSUDEK"]);
    // The state and the formula beside the title are the opening's lines.
    expect(
      ast.blocks.flatMap((block) =>
        block.type === "paragraph" && block.role === "intro"
          ? [block.plainText]
          : [],
      ),
    ).toEqual(["ČESKÁ REPUBLIKA", "JMÉNEM REPUBLIKY"]);
  });
});

describe("regional courts: opening quotation marks", () => {
  test("sit against the word they open, not the one before", async () => {
    for (const name of ["9-c-191-2025", "13-co-178-2022"]) {
      const ast = await readRegional(name);
      expect(
        texts(ast).filter((text) => /„\s/u.test(text)),
        name,
      ).toEqual([]);
    }
    expectWhole(
      await readRegional("13-co-178-2022"),
      "tedy „nese ze svého, čemu mohl zabránit",
    );
  });
});
