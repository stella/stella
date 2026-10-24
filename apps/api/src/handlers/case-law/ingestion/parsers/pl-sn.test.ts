import { describe, expect, test } from "bun:test";

import { sha256Hex } from "@stll/sha256/bun";

import {
  assemblePlSnParagraphs,
  extractPlSnLines,
  PL_PDF_PAGE_FURNITURE,
  plSnParagraphsToHtml,
  withoutRaisedReferenceMarkers,
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

const UOKIK_PDF = new URL(
  "__fixtures__/pl-uokik-dok-9-2011.pdf",
  import.meta.url,
);

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

describe("raised reference markers", () => {
  const span = (text: string, x: number, y: number, fontSize: number) => ({
    text,
    bbox: { x, y, width: text.length * 5 },
    fontSize,
    fontName: "Body",
  });

  test("a marker removes its own digits, not equal digits earlier in the line", () => {
    const line = {
      spans: [
        span("1. Úřad obdržel podnět", 0, 100, 10),
        span("1", 110, 104, 6),
        span(" a zahájil řízení.", 115, 100, 10),
      ],
      text: "1. Úřad obdržel podnět1 a zahájil řízení.",
      bbox: { x: 0, y: 100 },
    };
    const cleaned = withoutRaisedReferenceMarkers(line, 10);
    expect(cleaned.text).toBe("1. Úřad obdržel podnět a zahájil řízení.");
    expect(cleaned.spans.map(({ text }) => text)).toEqual([
      "1. Úřad obdržel podnět",
      " a zahájil řízení.",
    ]);
  });

  test("a raised digit without a matching footnote stays as text", () => {
    const line = {
      spans: [span("m", 0, 100, 10), span("2", 5, 104, 6)],
      text: "m2",
      bbox: { x: 0, y: 100 },
    };
    expect(withoutRaisedReferenceMarkers(line, 10, new Set()).text).toBe("m2");
  });
});

describe("reading recorded PDF lines", () => {
  test("the default reader keeps its byte-identical UOKiK output", async () => {
    const bytes = new Uint8Array(await Bun.file(UOKIK_PDF).arrayBuffer());
    const lines = await extractPlSnLines(bytes);
    const digest = sha256Hex(JSON.stringify(lines));

    expect(digest).toBe(
      "63491377b0a8cc8d1f205d0a43b32add539c1e0e6ef4f281ad252f9311d27592",
    );
  });

  test("the opt-in reader retains the UOKiK footnote zone as typed lines", async () => {
    const bytes = new Uint8Array(await Bun.file(UOKIK_PDF).arrayBuffer());
    const lines = await extractPlSnLines(bytes, undefined, {
      pageFurniture: PL_PDF_PAGE_FURNITURE.SEPARATE,
    });
    const notes = lines.filter(
      (line): line is PlSnTextLine =>
        line.type === "text" && line.footnote !== undefined,
    );
    const text = notes
      .flatMap(({ runs }) => runs.map((run) => run.text))
      .join(" ");

    expect(text).toContain("B. Turno, Komentarz do art. 105d");
    expect(notes.every(({ footnote }) => footnote?.label.length !== 0)).toBe(
      true,
    );
  });
});
