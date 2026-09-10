import { describe, expect, test } from "bun:test";

import {
  assemblePlSnParagraphs,
  plSnParagraphsToHtml,
} from "@/api/handlers/case-law/ingestion/parsers/pl-sn";
import type { PlSnLine } from "@/api/handlers/case-law/ingestion/parsers/pl-sn";

type PlSnTextLine = Extract<PlSnLine, { type: "text" }>;

const body = (text: string, bold = false): PlSnTextLine => ({
  type: "text",
  runs: [{ text, bold }],
  indented: false,
});

const opens = (text: string, bold = false): PlSnTextLine => ({
  ...body(text, bold),
  indented: true,
});

const BLANK: PlSnLine = { type: "blank" };

const plainText = (paragraphs: readonly { text: string }[][]): string[] =>
  paragraphs.map((runs) => runs.map(({ text }) => text).join(""));

describe("assembling sn.pl's typeset lines into paragraphs", () => {
  test("an indented line opens a paragraph and unindented lines continue it", () => {
    const paragraphs = assemblePlSnParagraphs([
      opens("Sąd Najwyższy rozpoznał sprawę"),
      body("ze skargi kasacyjnej powoda."),
      opens("Skarga podlega oddaleniu."),
    ]);

    expect(plainText(paragraphs)).toEqual([
      "Sąd Najwyższy rozpoznał sprawę ze skargi kasacyjnej powoda.",
      "Skarga podlega oddaleniu.",
    ]);
  });

  test("a blank line ends a paragraph without opening one", () => {
    const paragraphs = assemblePlSnParagraphs([
      body("Wyrok z dnia 23 czerwca 1994 r."),
      BLANK,
      BLANK,
      body("III ARN 36/94"),
    ]);

    expect(plainText(paragraphs)).toEqual([
      "Wyrok z dnia 23 czerwca 1994 r.",
      "III ARN 36/94",
    ]);
  });

  test("a paragraph runs on across a page break it is not indented after", () => {
    // Pages are concatenated in reading order, so the only signal that the
    // text continues is the absence of an indent on the first line overleaf.
    const paragraphs = assemblePlSnParagraphs([
      opens("Izba Skarbowa podzieliła stanowisko"),
      body("Urzędu Skarbowego w całości."),
    ]);

    expect(paragraphs).toHaveLength(1);
  });

  test("a word broken across lines is rejoined without its hyphen", () => {
    const paragraphs = assemblePlSnParagraphs([
      body("po rozpo-"),
      body("znaniu sprawy"),
    ]);

    expect(plainText(paragraphs)).toEqual(["po rozpoznaniu sprawy"]);
  });

  test("a compound broken at its own hyphen keeps it, and gains no space", () => {
    const paragraphs = assemblePlSnParagraphs([
      body("Sądowi Administracyjnego-"),
      body("Ośrodkowi Zamiejscowemu"),
    ]);

    expect(plainText(paragraphs)).toEqual([
      "Sądowi Administracyjnego-Ośrodkowi Zamiejscowemu",
    ]);
  });

  test("a paragraph of nothing but spaces is dropped", () => {
    expect(assemblePlSnParagraphs([body("   "), BLANK])).toEqual([]);
  });

  test("runs of the same weight merge across a line join, others do not", () => {
    const paragraphs = assemblePlSnParagraphs([
      { type: "text", indented: true, runs: [{ text: "Sąd", bold: true }] },
      {
        type: "text",
        indented: false,
        runs: [{ text: "Najwyższy", bold: true }],
      },
      {
        type: "text",
        indented: false,
        runs: [{ text: "orzekł", bold: false }],
      },
    ]);

    expect(paragraphs).toEqual([
      [
        { text: "Sąd Najwyższy", bold: true },
        { text: " orzekł", bold: false },
      ],
    ]);
  });
});

describe("emitting the paragraphs as markup the Polish parser reads", () => {
  test("bold survives as <b> and markup characters are escaped", () => {
    const html = plSnParagraphsToHtml([
      [
        { text: "UZASADNIENIE", bold: true },
        { text: ' w sprawie "A & B" <spółka>', bold: false },
      ],
    ]);

    expect(html).toBe(
      '<p><b>UZASADNIENIE</b> w sprawie "A &amp; B" &lt;spółka&gt;</p>',
    );
  });

  test("each paragraph is its own element", () => {
    const html = plSnParagraphsToHtml([
      [{ text: "Pierwszy", bold: false }],
      [{ text: "Drugi", bold: false }],
    ]);

    expect(html).toBe("<p>Pierwszy</p><p>Drugi</p>");
  });
});
