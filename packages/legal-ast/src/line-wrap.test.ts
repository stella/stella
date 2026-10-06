import { describe, expect, test } from "bun:test";

import type { Block, ParagraphBlock } from "./document-ast.js";
import {
  LINE_CONTINUATION_SEPARATOR,
  LINE_JOIN,
  LINE_WRAP_TYPE,
  planBlockLineWrap,
  planLineWrap,
} from "./line-wrap.js";
import type { LineJoin } from "./line-wrap.js";

/**
 * A constitutional-court decision as a fixed-width export stores it: one
 * stored line per printed line, wrapped near column 66. Written for this
 * test in the court's register; not a real decision.
 */
const WRAPPED_DECISION = [
  "N Á L E Z",
  "Ústavního soudu",
  "Jménem republiky",
  "Ústavní soud rozhodl v senátě složeném z předsedy senátu JUDr.",
  "Radoslava Hrona a soudců JUDr. Jakuba Dvořáčka a JUDr. Marty Malé",
  "ve věci ústavní stížnosti stěžovatele J. N., zastoupeného JUDr.",
  "P. K., advokátem, proti rozsudku Krajského soudu v Brně ze dne",
  "12. 3. 1998, sp. zn. 15 Co 112/97, takto:",
  "Ústavní stížnost se zamítá.",
  "Odůvodnění:",
  "Stěžovatel se ústavní stížností, která splňuje formální náležitosti",
  "stanovené zákonem č. 182/1993 Sb., o Ústavním soudu, domáhal",
  "zrušení v záhlaví uvedeného rozsudku, neboť podle jeho názoru jím",
  "obecné soudy porušily jeho základní právo na spravedlivý proces",
  "zaručené čl. 36 odst. 1 Listiny základních práv a svobod. Krajský",
  "soud podle stěžovatele nepřihlédl k důkazům, které navrhl, a své",
  "rozhodnutí řádně neodůvodnil, ačkoli tak byl povinen učinit podle",
  "§ 157 odst. 2 občanského soudního řádu, vyhlášeného ve Sbírce pod č.",
  "99/1963 Sb., ve znění pozdějších předpisů.",
  "Ústavní soud si vyžádal spis Okresního soudu v Brně-venkově a vyjádření",
  "účastníků řízení. Krajský soud ve svém vyjádření uvedl, že sociálně-",
  "právní poměry stěžovatele posoudil v souladu s ustálenou judikaturou.",
  "Ústavní soud proto ústavní stížnost podle § 82 odst. 1 zákona o",
  "Ústavním soudu zamítl.",
  "Poučení: Proti rozhodnutí Ústavního soudu není odvolání přípustné.",
  "V Brně dne 4. listopadu 1998",
  "JUDr. Radoslav Hron",
  "předseda senátu Ústavního soudu",
] as const;

const paragraph = (index: number, plainText: string): ParagraphBlock => ({
  id: `b${String(index)}`,
  anchorId: `p-${String(index)}`,
  type: "paragraph",
  inlines: [{ type: "text", text: plainText }],
  plainText,
});

/** The lines as the reader draws them, separators included. */
const drawn = (lines: readonly string[], joins: readonly LineJoin[]) =>
  lines
    .map((line, index) => {
      const join = joins[index - 1];
      if (index === 0 || join === undefined) {
        return line;
      }
      return join === LINE_JOIN.BREAK
        ? `\n${line}`
        : `${LINE_CONTINUATION_SEPARATOR[join]}${line}`;
    })
    .join("");

describe("hard-wrapped decision text", () => {
  test("a fixed-width export is recognised with its wrap column", () => {
    const { classification } = planLineWrap(WRAPPED_DECISION);
    expect(classification).toMatchObject({
      type: LINE_WRAP_TYPE.FIXED_WIDTH_WRAPPED,
      width: 71,
    });
  });

  test("wrapped sentences reflow and the decision's structure stays", () => {
    const { joins } = planLineWrap(WRAPPED_DECISION);
    expect(drawn(WRAPPED_DECISION, joins).split("\n")).toEqual([
      "N Á L E Z",
      "Ústavního soudu",
      "Jménem republiky",
      "Ústavní soud rozhodl v senátě složeném z předsedy senátu JUDr. Radoslava Hrona a soudců JUDr. Jakuba Dvořáčka a JUDr. Marty Malé ve věci ústavní stížnosti stěžovatele J. N., zastoupeného JUDr. P. K., advokátem, proti rozsudku Krajského soudu v Brně ze dne 12. 3. 1998, sp. zn. 15 Co 112/97, takto:",
      "Ústavní stížnost se zamítá.",
      "Odůvodnění:",
      "Stěžovatel se ústavní stížností, která splňuje formální náležitosti stanovené zákonem č. 182/1993 Sb., o Ústavním soudu, domáhal zrušení v záhlaví uvedeného rozsudku, neboť podle jeho názoru jím obecné soudy porušily jeho základní právo na spravedlivý proces zaručené čl. 36 odst. 1 Listiny základních práv a svobod. Krajský soud podle stěžovatele nepřihlédl k důkazům, které navrhl, a své rozhodnutí řádně neodůvodnil, ačkoli tak byl povinen učinit podle § 157 odst. 2 občanského soudního řádu, vyhlášeného ve Sbírce pod č. 99/1963 Sb., ve znění pozdějších předpisů.",
      "Ústavní soud si vyžádal spis Okresního soudu v Brně-venkově a vyjádření účastníků řízení. Krajský soud ve svém vyjádření uvedl, že sociálně-právní poměry stěžovatele posoudil v souladu s ustálenou judikaturou.",
      "Ústavní soud proto ústavní stížnost podle § 82 odst. 1 zákona o Ústavním soudu zamítl.",
      "Poučení: Proti rozhodnutí Ústavního soudu není odvolání přípustné.",
      "V Brně dne 4. listopadu 1998",
      "JUDr. Radoslav Hron",
      "předseda senátu Ústavního soudu",
    ]);
  });

  test("a line-end hyphen is kept and joined without a space", () => {
    const { joins } = planLineWrap(WRAPPED_DECISION);
    const hyphenAt = WRAPPED_DECISION.indexOf(
      "účastníků řízení. Krajský soud ve svém vyjádření uvedl, že sociálně-",
    );
    expect(joins[hyphenAt]).toBe(LINE_JOIN.HYPHEN);
  });

  test("a numbered point opens a new paragraph after a wrapped one", () => {
    const lines = [
      ...WRAPPED_DECISION.slice(10, 19),
      "2. Ústavní soud přezkoumal napadené rozhodnutí a dospěl k závěru,",
      "že ústavní stížnost není důvodná.",
    ];
    const { joins } = planLineWrap(lines);
    expect(joins.at(8)).toBe(LINE_JOIN.BREAK);
    expect(joins.at(9)).toBe(LINE_JOIN.SPACE);
  });

  test("lines of one length that never run on are not wrapped", () => {
    // A ruling list: every line near one column, every line a sentence.
    const lines = Array.from(
      { length: 10 },
      (_, index) =>
        `Ústavní soud odmítá návrh stěžovatele číslo ${String(index + 10)} jako zjevně neopodstatněný.`,
    );
    expect(planLineWrap(lines).classification).toEqual({
      type: LINE_WRAP_TYPE.UNWRAPPED,
    });
  });

  // Within the fit tolerance a short line could make a joined line no longer
  // than the column, which a second pass would join onward.
  test("a joined line is never joined again", () => {
    const lines = [
      ...Array.from(
        { length: 10 },
        () => "a soud uvedl, že stěžovatel podal ústavní stížnost včas a",
      ),
      "a Ústavní soud vzal na vědomí sdělení stěžovatele ze dne 4. 5. a",
      "též",
      "a vyjádření účastníků řízení, které Krajský soud předložil.",
      ...Array.from(
        { length: 4 },
        () =>
          "Ústavní soud proto rozhodl, jak je uvedeno ve výroku tohoto usnesení.",
      ),
    ];
    const once = drawn(lines, planLineWrap(lines).joins).split("\n");
    expect(planLineWrap(once).classification.type).toBe(
      LINE_WRAP_TYPE.FIXED_WIDTH_WRAPPED,
    );
    expect(drawn(once, planLineWrap(once).joins).split("\n")).toEqual(once);
  });

  test("a document of short paragraphs is not wrapped", () => {
    const lines = [
      "Ústavní stížnost se odmítá.",
      "Stěžovatel podal ústavní stížnost včas.",
      "Ústavní soud vyzval stěžovatele k odstranění vad podání.",
      "Stěžovatel na výzvu nereagoval.",
      "Podání proto trpí vadou, kterou nelze odstranit.",
      "Ústavní soud stížnost odmítl.",
      "Proti usnesení není odvolání přípustné.",
      "V Brně dne 4. listopadu 1998",
      "JUDr. Radoslav Hron",
    ];
    expect(planLineWrap(lines)).toEqual({
      classification: { type: LINE_WRAP_TYPE.UNWRAPPED },
      joins: lines.slice(1).map(() => LINE_JOIN.BREAK),
    });
  });

  test("paragraph blocks of a wrapped decision continue one another", () => {
    const blocks: Block[] = WRAPPED_DECISION.map((line, index) =>
      paragraph(index, line),
    );
    const plan = planBlockLineWrap(blocks);
    const continuedIds = [...plan.continuations.keys()];
    expect(plan.classification.type).toBe(LINE_WRAP_TYPE.FIXED_WIDTH_WRAPPED);
    expect(continuedIds).toContain("b4");
    expect(continuedIds).not.toContain("b3");
    expect(plan.continuations.get("b21")).toBe(LINE_JOIN.HYPHEN);
  });

  test("a signature or numbered paragraph is never continued", () => {
    const blocks: Block[] = WRAPPED_DECISION.map((line, index) =>
      paragraph(index, line),
    );
    const signature = blocks.length - 1;
    const numbered = 12;
    blocks[signature] = { ...paragraph(signature, "x"), role: "signature" };
    blocks[numbered] = {
      ...paragraph(numbered, WRAPPED_DECISION[numbered]),
      number: 3,
    };
    const { continuations } = planBlockLineWrap(blocks);
    expect(continuations.has(`b${String(numbered)}`)).toBe(false);
    expect(continuations.has(`b${String(numbered + 1)}`)).toBe(false);
    expect(continuations.has(`b${String(signature)}`)).toBe(false);
  });
});
