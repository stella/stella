/**
 * Where the common-court reading must leave the court's markup alone.
 *
 * The positive cases run on recorded judgments in
 * `adapters/pl-common-court-text.test.ts`; these are the boundaries a reading
 * built from them could cross: lines the court ended on purpose, and markup
 * that only looks like the serializer's.
 */

import { describe, expect, test } from "bun:test";

import { hasInlineChildren } from "@stll/legal-ast/document-ast";
import type { Inline } from "@stll/legal-ast/document-ast";

import {
  parsePlDecisionContent,
  PL_DECISION_MARKUP,
} from "@/api/handlers/case-law/ingestion/parsers/pl-courts";

const read = (content: string) =>
  parsePlDecisionContent({
    caseNumber: "I C 1/20",
    ecli: undefined,
    court: "Sąd Rejonowy",
    decisionDate: undefined,
    decisionType: undefined,
    sourceUrl: undefined,
    documentUrl: undefined,
    content,
    keywords: [],
    statutes: [],
    documentId: "markup",
    superscripts: true,
    markup: PL_DECISION_MARKUP.COMMON_COURT,
  }).documentAst.blocks;

const paragraphs = (content: string): string[] =>
  read(content).flatMap((block) =>
    block.type === "paragraph" ? [block.plainText] : [],
  );

const hasSuperscript = (inlines: readonly Inline[]): boolean =>
  inlines.some(
    (inline) =>
      inline.type === "superscript" ||
      (hasInlineChildren(inline) && hasSuperscript(inline.children)),
  );

/** A justified line the editor broke before a one-letter word. */
const WRAPPED =
  "Uzasadniając swoje stanowisko procesowe powodowie wskazali, że zawarli";

describe("a line the court ended stays ended", () => {
  test("a wrapped line goes on with its sentence", () => {
    expect(paragraphs(`<p>${WRAPPED} <br/>z pozwanym umowę.</p>`)).toEqual([
      `${WRAPPED} z pozwanym umowę.`,
    ]);
  });

  test.each(["1.", "(2)", "1.2.3.", "123.45)", "a)", "ą."])(
    "a numbered point %s keeps its preceding line break",
    (marker) => {
      expect(
        paragraphs(`<p>${WRAPPED}<br/>${marker} treść punktu</p>`),
      ).toEqual([`${WRAPPED}\n${marker} treść punktu`]);
    },
  );

  test.each([
    ["an address", "<p>Jan Kowalski<br/>ul. Długa 1<br/>00-001 Warszawa</p>"],
    [
      "an address on a long line",
      "<p>pozwany zamieszkały w Warszawie przy ulicy Długiej 1 m. 5,<br/>00-001 Warszawa</p>",
    ],
    ["a signature", "<p>SSA Anna Nowak<br/>sędzia sprawozdawca</p>"],
    [
      "an operative point after a semicolon",
      "<p>I. oddala apelację w całości jako bezzasadną w pozostałym zakresie;<br/>zasądza od powoda na rzecz pozwanego koszty</p>",
    ],
    [
      "an operative point after a full line",
      "<p>I. zmienia zaskarżony wyrok w punkcie pierwszym w ten sposób, że<br/>oddala powództwo</p>",
    ],
    [
      "a lettered point",
      "<p>wniósł o zasądzenie od pozwanego na swoją rzecz następujących kwot<br/>a) 100 zł tytułem kary</p>",
    ],
  ])("%s keeps its lines", (_, html) => {
    const [paragraph] = paragraphs(html);
    expect(paragraph?.split("\n").length).toBe(html.split("<br/>").length);
  });

  test.each([
    [
      "a long line of judges",
      "<p>SSA Anna Kowalska-Nowak, SSA Jan Kowalski, SSA Piotr Nowak<br/>sędzia sprawozdawca</p>",
    ],
    [
      "a role after a long line of names",
      "<p>Anna Kowalska-Nowak, Jan Kowalski, Piotr Nowak, Maria Wiśniewska<br/>sędzia sprawozdawca</p>",
    ],
  ])("the bench's signature, %s, keeps its lines", (_, html) => {
    const [paragraph] = paragraphs(html);
    expect(paragraph?.split("\n")).toHaveLength(2);
    expect(paragraph?.endsWith("\nsędzia sprawozdawca")).toBe(true);
  });
});

describe("an article index keeps the line it ends", () => {
  test("a cell paragraph ending in an index stays its own line", () => {
    const cells = read(
      "<table><tr><td><p>art. 385<sup>1</sup></p><p>2. oddala apelację.</p></td><td>x</td></tr></table>",
    ).flatMap((block) =>
      block.type === "table"
        ? block.rows.flatMap((row) => row.map((cell) => cell.plainText))
        : [],
    );

    expect(cells).toEqual(["art. 3851\n2. oddala apelację.", "x"]);
  });

  test.each([
    ["<pre>", "<pre>art. 385<sup>1\n</sup>k.c.</pre>"],
    [
      "white-space: pre-wrap",
      '<p style="white-space: pre-wrap">art. 385<sup>1\n</sup>k.c.</p>',
    ],
  ])("a break kept by %s after an index stays a break", (_, html) => {
    expect(paragraphs(html)).toEqual(["art. 3851\nk.c."]);
  });
});

describe("markup that only looks like the serializer's is the court's", () => {
  test("a space before an empty comment between words stays", () => {
    expect(paragraphs("<p><b>Sąd</b> <!-- --><b>Rejonowy</b></p>")).toEqual([
      "Sąd Rejonowy",
    ]);
  });

  test("the serializer's newline at an inline's start goes", () => {
    expect(
      paragraphs("<p>przy współpracy z Biura<u>\n<!-- -->mi</u></p>"),
    ).toEqual(["przy współpracy z Biurami"]);
  });
});

describe("text straight in a frame is read as a paragraph", () => {
  test("a one-cell row keeps its inline marks in one paragraph", () => {
    const blocks = read(
      "<table><tr><td>art. 353<sup>1</sup> k.c.</td></tr></table>",
    );
    const texts = blocks.flatMap((block) =>
      block.type === "paragraph" ? [block] : [],
    );

    expect(texts.map((block) => block.plainText)).toEqual(["art. 3531 k.c."]);
    expect(texts.every((block) => hasSuperscript(block.inlines))).toBe(true);
  });

  test("a list item's marker opens text set straight in the item", () => {
    expect(paragraphs("<dl><dt>a)</dt><dd>oddala apelację</dd></dl>")).toEqual([
      "a) oddala apelację",
    ]);
  });

  test("a marker with no item is kept where it stands, once", () => {
    expect(
      paragraphs("<dl><dt>-</dt><dd><p>pierwszy</p></dd><dt>*</dt></dl>"),
    ).toEqual(["- pierwszy", "*"]);
  });
});
