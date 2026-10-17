import { describe, expect, test } from "bun:test";

import {
  assemblePdfParagraphs,
  pdfParagraphsToHtml,
} from "@/api/lib/legal-search/parsers/pdf-paragraphs";
import type { PdfParagraphLine } from "@/api/lib/legal-search/parsers/pdf-paragraphs";

type PlSnTextLine = Extract<PdfParagraphLine, { type: "text" }>;

const body = (text: string, bold = false): PlSnTextLine => ({
  type: "text",
  runs: [{ text, bold }],
  indented: false,
});

const opens = (text: string, bold = false): PlSnTextLine => ({
  ...body(text, bold),
  indented: true,
});

const BLANK: PdfParagraphLine = { type: "blank" };

const plainText = (
  paragraphs: readonly { runs: readonly { text: string }[] }[],
): string[] =>
  paragraphs.map(({ runs }) => runs.map(({ text }) => text).join(""));

describe("assembling sn.pl's typeset lines into paragraphs", () => {
  test("an indented line opens a paragraph and unindented lines continue it", () => {
    const paragraphs = assemblePdfParagraphs([
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
    const paragraphs = assemblePdfParagraphs([
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
    const paragraphs = assemblePdfParagraphs([
      opens("Izba Skarbowa podzieliła stanowisko"),
      body("Urzędu Skarbowego w całości."),
    ]);

    expect(paragraphs).toHaveLength(1);
  });

  test("a word broken across lines is rejoined without its hyphen", () => {
    const paragraphs = assemblePdfParagraphs([
      body("po rozpo-"),
      body("znaniu sprawy"),
    ]);

    expect(plainText(paragraphs)).toEqual(["po rozpoznaniu sprawy"]);
  });

  test("a compound broken at its own hyphen keeps it, and gains no space", () => {
    const paragraphs = assemblePdfParagraphs([
      body("Sądowi Administracyjnego-"),
      body("Ośrodkowi Zamiejscowemu"),
    ]);

    expect(plainText(paragraphs)).toEqual([
      "Sądowi Administracyjnego-Ośrodkowi Zamiejscowemu",
    ]);
  });

  test("a paragraph of nothing but spaces is dropped", () => {
    expect(assemblePdfParagraphs([body("   "), BLANK])).toEqual([]);
  });

  test("runs of the same weight merge across a line join, others do not", () => {
    const paragraphs = assemblePdfParagraphs([
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

    expect(paragraphs.map(({ runs }) => runs)).toEqual([
      [
        { text: "Sąd Najwyższy", bold: true },
        { text: " orzekł", bold: false },
      ],
    ]);
  });
});

describe("emitting the paragraphs as markup the Polish parser reads", () => {
  test("bold survives as <b> and markup characters are escaped", () => {
    const html = pdfParagraphsToHtml([
      {
        runs: [
          { text: "UZASADNIENIE", bold: true },
          { text: ' w sprawie "A & B" <spółka>', bold: false },
        ],
      },
    ]);

    expect(html).toBe(
      '<p><b>UZASADNIENIE</b> w sprawie "A &amp; B" &lt;spółka&gt;</p>',
    );
  });

  test("each paragraph is its own element", () => {
    const html = pdfParagraphsToHtml([
      { runs: [{ text: "Pierwszy", bold: false }] },
      { runs: [{ text: "Drugi", bold: false }] },
    ]);

    expect(html).toBe("<p>Pierwszy</p><p>Drugi</p>");
  });
});
