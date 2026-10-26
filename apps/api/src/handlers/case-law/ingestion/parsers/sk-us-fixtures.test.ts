import { describe, expect, test } from "bun:test";

import {
  type Block,
  type HeadingBlock,
  type ParagraphBlock,
  projectPlainText,
} from "@stll/legal-ast/document-ast";

import { parseSkUsDocumentXhtml } from "@/api/handlers/case-law/ingestion/parsers/sk-us";
import { readGzipJson } from "@/api/lib/gzip-json";

const FIXTURES = new URL("__fixtures__/", import.meta.url);

/** A recorded `dms/content` response: the decision as base64 XHTML. */
const parsedFixture = async (name: string, caseNumber: string) => {
  const payload = await readGzipJson(
    new URL(`${name}.content.json.gz`, FIXTURES),
  );
  const content =
    typeof payload === "object" &&
    payload !== null &&
    "content" in payload &&
    typeof payload.content === "string"
      ? payload.content
      : "";
  expect(content).not.toBe("");
  return parseSkUsDocumentXhtml({
    xhtml: Buffer.from(content, "base64").toString("utf-8"),
    caseNumber,
    ecli: undefined,
    court: "Ústavný súd SR",
    decisionDate: undefined,
    decisionType: undefined,
    documentUrl: "https://www.ustavnysud.sk/docDownload/fixture",
  }).documentAst.blocks;
};

/** What search and the reader see: the text the stored inlines project to. */
const textOf = (block: HeadingBlock | ParagraphBlock): string =>
  projectPlainText(block.inlines);

const paragraphs = (blocks: readonly Block[]): ParagraphBlock[] =>
  blocks.filter((block): block is ParagraphBlock => block.type === "paragraph");

const headings = (blocks: readonly Block[], level?: number): string[] =>
  blocks.flatMap((block) =>
    block.type === "heading" && (level === undefined || block.level === level)
      ? [textOf(block)]
      : [],
  );

describe("letter-spaced emphasis (PL. ÚS 15/98)", () => {
  test("short spaced words keep the gaps between them", async () => {
    const blocks = await parsedFixture("sk-us-pl-us-15-98", "PL. ÚS 15/98");
    const holding = paragraphs(blocks).filter(
      (block) => block.role === "holding",
    );
    // The court prints `zákonov   n i e   j e   v súlade`: one space between
    // letters, three between words. Read letter by letter, the gaps welded
    // the words into `niejev`.
    expect(
      holding.map(textOf).filter((text) => text.includes("nie je v súlade")),
    ).toHaveLength(5);
    expect(
      blocks
        .map((block) => ("inlines" in block ? textOf(block) : ""))
        .join("\n"),
    ).not.toContain("niejev");
    expect(holding.map(textOf).at(-1)).toBe(
      "6. Vo zvyšnej časti návrhu nevyhovuje.",
    );
  });

  test("the holding marker sharing a line with the first point is a heading of its own", async () => {
    const blocks = await parsedFixture("sk-us-pl-us-15-98", "PL. ÚS 15/98");
    expect(headings(blocks, 2)).toEqual(["rozhodol:", "Odôvodnenie:"]);
    const firstPoint = paragraphs(blocks).find(
      (block) => block.role === "holding",
    );
    expect(firstPoint === undefined ? "" : textOf(firstPoint)).toStartWith(
      "1. Ustanovenie čl. I § 23 ods. 1",
    );
    // The reasoning's first paragraph is a paragraph, not glued to its marker.
    const reasoning = blocks.findIndex(
      (block) => block.type === "heading" && block.anchorId === "h-reasoning",
    );
    const next = blocks[reasoning + 1];
    expect(next?.type).toBe("paragraph");
    expect(
      next !== undefined && next.type === "paragraph" ? textOf(next) : "",
    ).toStartWith("Ústavnému súdu Slovenskej republiky bol 30. júna 1998");
  });
});

describe("the page numbers the markup keeps from the file", () => {
  test("a page number opening a page's first line leaves the text, and the page break leaves the sentence", async () => {
    const blocks = await parsedFixture("sk-us-pl-us-15-98", "PL. ÚS 15/98");
    const texts = paragraphs(blocks).map(textOf);
    // `… do Slovenskej` / `3 národnej rady v znení …`: one sentence, one page
    // number between its halves.
    expect(
      texts.some((text) =>
        text.includes(
          "č. 80/1990 Zb. o voľbách do Slovenskej národnej rady v znení neskorších predpisov a o zmene a doplnení ďalších zákonov nie je v súlade s čl. 30 ods. 4 a čl. 31",
        ),
      ),
    ).toBe(true);
    expect(texts.some((text) => text.startsWith("3 národnej rady"))).toBe(
      false,
    );
  });

  test("a numbered point that opens a page keeps its number (PL. ÚS 24/2014)", async () => {
    const blocks = await parsedFixture("sk-us-pl-us-24-2014", "PL. ÚS 24/2014");
    const numbered = paragraphs(blocks).filter(
      (block) => block.number !== undefined,
    );
    expect(numbered.map((block) => block.number)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
    ]);
    const point = numbered.find((block) => block.number === 4);
    expect(point === undefined ? "" : textOf(point)).toStartWith(
      "Obsah referendových otázok by sa ďalej podľa navrhovateľa „mohol týkať:",
    );
  });

  test("a page number closing a page's last line leaves the text (PL. ÚS 1/2021)", async () => {
    const blocks = await parsedFixture("sk-us-pl-us-1-2021", "PL. ÚS 1/2021");
    const first = paragraphs(blocks).find((block) => block.number === 1);
    expect(first === undefined ? "" : textOf(first)).toMatch(
      /\(ďalej len „dodatkový protokol“\) a čl\. 17 Charty/u,
    );
  });
});

describe("the parts of a part (PL. ÚS 1/2021)", () => {
  test("every outline title is a heading, not the head of the paragraph after it", async () => {
    const blocks = await parsedFixture("sk-us-pl-us-1-2021", "PL. ÚS 1/2021");
    const outline = headings(blocks, 4);
    expect(outline).toHaveLength(27);
    expect(outline).toContain("II.1. Stanovisko národnej rady:");
    expect(outline).toContain("III.2.1. Rekodifikácia:");
    // A title the court wrapped onto a second line is one heading.
    expect(outline).toContain(
      "IV.3. Súlad s princípmi právneho štátu vrátane princípu primeranosti (čl. 1 ods. 1 ústavy, čl. 13 ods. 4 ústavy, čl. 16 ods. 2 ústavy):",
    );
    expect(
      paragraphs(blocks).filter((block) => /^[IVX]+\.\d/u.test(textOf(block))),
    ).toEqual([]);
    const council = paragraphs(blocks).find((block) => block.number === 13);
    expect(council === undefined ? "" : textOf(council)).toStartWith(
      "Národná rada vo vyjadrení č. PREDS-138-1/2021",
    );
  });

  test("a part's title printed under its numeral belongs to its heading", async () => {
    const blocks = await parsedFixture("sk-us-pl-us-1-2021", "PL. ÚS 1/2021");
    expect(headings(blocks, 3)).toEqual([
      "I. Návrh na začatie konania",
      "II. Stanoviská účastníkov konania a vedľajšieho účastníka konania a ďalší priebeh konania",
      "III. Východiská na posúdenie dôvodnosti návrhu",
      "IV. Posúdenie dôvodnosti návrhu",
    ]);
  });
});

describe("PL. ÚS 10/2014", () => {
  test("the hyphen the court's file prints as U+00AD reads as a hyphen", async () => {
    const blocks = await parsedFixture("sk-us-pl-us-10-2014", "PL. ÚS 10/2014");
    const text = blocks
      .map((block) => ("inlines" in block ? textOf(block) : ""))
      .join("\n");
    expect(text).not.toContain(String.fromCodePoint(0xad));
    expect(headings(blocks, 1)).toContain("PL. ÚS 10/2014-78");
    expect(text).toContain("peer-to-peer (P2P)");
    expect(text).toContain("C-293/12 a C-594/12");
    // Hyphens at a line's end are the court's too: a compound and a docket.
    expect(text).toContain("obrazovo-zvukových");
    expect(text).toContain("Landesregierung a iní, C-293/12 a C-594/12");
  });

  test("a quoted `takto rozhodol:` inside the reasoning does not turn the reasoning into the holding", async () => {
    const blocks = await parsedFixture("sk-us-pl-us-10-2014", "PL. ÚS 10/2014");
    expect(headings(blocks, 2)).toEqual(["rozhodol:", "Odôvodnenie:"]);
    expect(headings(blocks, 3)).toEqual([
      "I.",
      "II. Ďalší priebeh konania",
      "III. Základné východiská pre rozhodovanie o návrhu skupiny poslancov",
      "IV. Analýza napadnutej právnej úpravy a závery",
      "V.",
    ]);
    const reasoning = blocks.findIndex(
      (block) => block.type === "heading" && block.anchorId === "h-reasoning",
    );
    expect(
      paragraphs(blocks.slice(reasoning)).filter(
        (block) => block.role === "holding",
      ),
    ).toEqual([]);
  });
});
