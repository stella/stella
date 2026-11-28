import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  CZ_NS_SBIRKA_TEXT_HEADING,
  parseCzNsSbirkaText as uncheckedParseCzNsSbirkaText,
  readCzNsSbirkaPage,
} from "@stll/case-law-parsers/cz-ns-sbirka";
import { guardParser } from "@stll/case-law-parsers/parser-reader-guard";

import {
  CZ_NS_SBIRKA_RECORDINGS,
  czNsSbirkaRecordedPage,
} from "@/api/tests/helpers/case-law-enrolled-fixtures";

const parseCzNsSbirkaText = guardParser(uncheckedParseCzNsSbirkaText);

const IDENTITY = {
  postId: "1",
  sourceUrl: "https://sbirka.nsoud.cz/sbirka/1/",
  caseNumber: "1 Cdo 1/2020",
  ecli: undefined,
  court: "Nejvyšší soud",
  decisionDate: undefined,
  decisionType: undefined,
  keywords: [],
  statutes: [],
} as const;

/** Every label the collection's detail pages state. */
const LABELS = new Set([
  "Právní věta",
  "Anotace",
  "Soud",
  "Datum rozhodnutí",
  "Spisová značka",
  "Číslo rozhodnutí",
  "Rok",
  "Sešit",
  "Typ rozhodnutí",
  "Heslo",
  "Předpisy",
  "Druh",
  "Dotčená rozhodnutí",
  "Ústavní stížnost",
]);

describe("an entry's detail page", () => {
  test("every recording reads into known labels and a text that parses", () => {
    for (const postId of CZ_NS_SBIRKA_RECORDINGS) {
      const page = readCzNsSbirkaPage(czNsSbirkaRecordedPage(postId));
      expect({ postId, title: page.title !== undefined }).toEqual({
        postId,
        title: true,
      });
      for (const label of page.fields.keys()) {
        expect({ postId, label, known: LABELS.has(label) }).toEqual({
          postId,
          label,
          known: true,
        });
      }
      expect(page.textHeading).toBe(CZ_NS_SBIRKA_TEXT_HEADING);
      const parsed = parseCzNsSbirkaText(page.textHtml ?? "", {
        ...IDENTITY,
        postId,
      });
      expect(Result.isOk(parsed)).toBe(true);
    }
  });

  test("the court label's tooltip is not part of the label", () => {
    const page = readCzNsSbirkaPage(czNsSbirkaRecordedPage("9586"));
    expect(page.fields.get("Soud")).toEqual(["Nejvyšší soud SSR"]);
  });

  test("provisions keep one entry per printed line", () => {
    const page = readCzNsSbirkaPage(czNsSbirkaRecordedPage("9586"));
    expect(page.fields.get("Předpisy")?.at(0)).toBe(
      "92/1962 Sb. § 17 99/1963 Sb. § 5",
    );
    expect(page.fields.get("Předpisy")?.at(1)).toBe("§ 120");
  });

  test("the breadcrumb names the year and the issue", () => {
    const page = readCzNsSbirkaPage(czNsSbirkaRecordedPage("13914"));
    expect(page.breadcrumb).toContain("Rok 2004");
    expect(page.breadcrumb).toContain("Sešit č. 7/2004");
  });
});

describe("the collection's text", () => {
  test("a centred bold paragraph is a heading; a wholly italic one is apparatus", () => {
    const parsed = parseCzNsSbirkaText(
      `<div class="detail-section__table-heading"><span>Sbírkový text rozhodnutí</span></div>` +
        `<p style="text-align: justify"><em>Soud prvního stupně žalobu zamítl.</em></p>` +
        `<p style="text-align: center"><strong>Z odůvodnění:</strong></p>` +
        `<p style="text-align: justify">Dovolání je důvodné, <em>jak</em> uvedeno.</p>` +
        `<p style="text-align: justify"><strong>Tučně</strong> uprostřed.</p>` +
        `<p><em>Zdůrazněno soudem.</em></p>`,
      IDENTITY,
    );
    if (Result.isError(parsed)) {
      throw parsed.error;
    }
    expect(
      parsed.value.documentAst.blocks.map((block) => [
        block.type,
        "role" in block ? (block.role ?? null) : null,
        block.plainText,
      ]),
    ).toEqual([
      ["heading", "publisher-heading", "Sbírkový text rozhodnutí"],
      ["paragraph", "apparatus", "Soud prvního stupně žalobu zamítl."],
      ["heading", "section-heading", "Z odůvodnění:"],
      ["paragraph", null, "Dovolání je důvodné, jak uvedeno."],
      ["paragraph", null, "Tučně uprostřed."],
      // Italics after the court's words began are its own emphasis.
      ["paragraph", null, "Zdůrazněno soudem."],
    ]);
    expect(parsed.value.sections).toBeDefined();
  });

  test("numbered paragraphs carry the court's number", () => {
    const parsed = parseCzNsSbirkaText(
      `<p>1. Žalobou se žalobci domáhali zaplacení.</p>` +
        `<p>2. Soud prvního stupně žalobě vyhověl.</p>` +
        `<p>3. Odvolací soud rozsudek potvrdil.</p>`,
      IDENTITY,
    );
    if (Result.isError(parsed)) {
      throw parsed.error;
    }
    expect(
      parsed.value.documentAst.blocks.flatMap((block) =>
        block.type === "paragraph" ? [block.number] : [],
      ),
    ).toEqual([1, 2, 3]);
  });

  test("source tabs and line breaks read as one space, as a browser shows them", () => {
    const lines = new Map<string, string[]>();
    for (const postId of CZ_NS_SBIRKA_RECORDINGS) {
      const page = readCzNsSbirkaPage(czNsSbirkaRecordedPage(postId));
      const parsed = parseCzNsSbirkaText(page.textHtml ?? "", {
        ...IDENTITY,
        postId,
      });
      if (Result.isError(parsed)) {
        throw parsed.error;
      }
      const texts = parsed.value.documentAst.blocks.flatMap((block) =>
        block.type === "paragraph" || block.type === "heading"
          ? [block.plainText]
          : [],
      );
      lines.set(postId, texts);
      for (const text of texts) {
        expect({
          postId,
          text,
          raw: /[\t\r]| {2}|\n\n|^\s|\s$/u.test(text),
        }).toEqual({
          postId,
          text,
          raw: false,
        });
      }
    }
    expect(lines.get("5819")).toContain("II.\nDovolání a vyjádření k němu");
    expect(
      lines.get("13914")?.some((text) => text.includes("1) na jaře roku 1998")),
    ).toBe(true);
  });

  test("an empty text cell is a typed failure, not an empty document", () => {
    expect(
      Result.isError(
        parseCzNsSbirkaText(
          `<p style="text-align: justify;"><em></p>`,
          IDENTITY,
        ),
      ),
    ).toBe(true);
  });
});
