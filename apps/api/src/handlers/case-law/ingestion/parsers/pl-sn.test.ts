import { ops, PDF, PdfArray, PdfNumber, PdfString } from "@libpdf/core";
import { describe, expect, test } from "bun:test";

import type { DocumentAst, Inline } from "@stll/legal-ast/document-ast";
import { hasInlineChildren } from "@stll/legal-ast/inline";
import { sha256Hex } from "@stll/sha256/bun";

import {
  assemblePlSnParagraphs,
  extractPlPdfLetterheadContent,
  extractPlPdfSeparatedContent,
  extractPlSnLines,
  parsePlSnDecisionPdf,
  PL_PDF_PARAGRAPH_START,
  plSnParagraphsToHtml,
  withoutRaisedReferenceMarkers,
} from "@/api/handlers/case-law/ingestion/parsers/pl-sn";
import type { PlSnLine } from "@/api/handlers/case-law/ingestion/parsers/pl-sn";
import { inlinesToPlainText } from "@/api/handlers/case-law/ingestion/parsers/shared-inlines";

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

type Drawn = { text: string; x: number; y: number; size: number };

/**
 * A Supreme Court page read the way the court sets it: three lines of
 * running text in `bodySize` type, plus `extra`.
 */
const readSupremeCourtPage = async (
  bodySize: number,
  extra: readonly Drawn[],
) => {
  const pdf = PDF.create();
  const page = pdf.addPage({ size: "letter" });
  for (const index of [0, 1, 2]) {
    page.drawText("Running text sets the ordinary body type of the page.", {
      x: 72,
      y: 600 - index * bodySize * 1.25,
      size: bodySize,
    });
  }
  for (const { text, x, y, size } of extra) {
    page.drawText(text, { x, y, size });
  }
  const paragraphs = assemblePlSnParagraphs(
    await extractPlSnLines(await pdf.save(), PL_PDF_PARAGRAPH_START.INDENT, {
      supremeCourt: { docket: "I CSK 1/26" },
    }),
  );
  return {
    texts: plainText(paragraphs),
    superscripts: paragraphs.flatMap((runs) =>
      runs.flatMap(({ superscript, text }) =>
        superscript === true ? [text] : [],
      ),
    ),
  };
};

const readLetterheadPage = async (
  footer: string,
  { x = 250, y = 36 }: { x?: number; y?: number } = {},
): Promise<string> => {
  const pdf = PDF.create();
  const page = pdf.addPage({ size: "letter" });
  for (const [index, text] of [
    "Ordinary body text line one.",
    "Ordinary body text line two.",
    "Ordinary body text line three.",
  ].entries()) {
    page.drawText(text, { x: 72, y: 700 - index * 15, size: 12 });
  }
  page.drawText(footer, { x, y, size: 12 });
  const content = await extractPlPdfLetterheadContent(
    await pdf.save(),
    PL_PDF_PARAGRAPH_START.INDENT,
  );
  return plainText(assemblePlSnParagraphs(content.body)).join("\n");
};

describe("page numbers on letterhead pages", () => {
  test.each([
    "1",
    "-1-",
    "1/16",
    "Strona 1 z 16",
    "str.1",
    "Strona   1   z   16",
  ])("removes the centered page number form %s", async (footer) => {
    const text = await readLetterheadPage(footer);
    expect(text).not.toContain(footer);
    expect(text).toContain("Ordinary body text line one.");
  });

  test("keeps another page's number and a left-aligned body reference", async () => {
    const wrongPage = await readLetterheadPage("2");
    expect(wrongPage).toContain("2");

    const bodyReference = await readLetterheadPage("str. 1", { x: 72, y: 700 });
    expect(bodyReference).toContain("str. 1");
  });
});

describe("small digits the text layer prints as a line of their own", () => {
  test("a thousands group stays in its amount", async () => {
    const { texts, superscripts } = await readSupremeCourtPage(12, [
      { text: "Kara 10", x: 72, y: 700, size: 12 },
      { text: "000", x: 118, y: 703, size: 7 },
      { text: " PLN", x: 130, y: 700, size: 12 },
    ]);
    expect(superscripts).toEqual([]);
    expect(texts.some((text) => /^Kara 10 000 PLN(?: |$)/u.test(text))).toBe(
      true,
    );
  });

  test("a digit raised less than an index is set stays on its line", async () => {
    // 2.2pt over 16pt type: past the 2pt the text layer keeps on a line,
    // short of the 2.4pt an index is raised at least.
    const { texts, superscripts } = await readSupremeCourtPage(16, [
      { text: "Tekst", x: 72, y: 700, size: 16 },
      { text: "1", x: 111.5, y: 702.2, size: 7 },
      { text: " follows", x: 116, y: 700, size: 16 },
    ]);
    expect(superscripts).toEqual([]);
    expect(texts.some((text) => /^Tekst1 follows(?: |$)/u.test(text))).toBe(
      true,
    );
  });

  test("an article's index raised as an index is set stays a superscript", async () => {
    const { texts, superscripts } = await readSupremeCourtPage(16, [
      { text: "art. 394", x: 72, y: 700, size: 16 },
      { text: "1", x: 132, y: 705, size: 7 },
      { text: " k.p.c.", x: 137, y: 700, size: 16 },
    ]);
    expect(superscripts).toEqual(["1"]);
    expect(texts.some((text) => text.startsWith("art. 3941"))).toBe(true);
  });
});

describe("reading recorded PDF lines", () => {
  test("the default reader keeps its byte-identical output on a UOKiK PDF", async () => {
    const bytes = new Uint8Array(await Bun.file(UOKIK_PDF).arrayBuffer());
    const lines = await extractPlSnLines(bytes);
    const digest = sha256Hex(JSON.stringify(lines));

    // Re-pinned once: the PDF reader now reads glyphs its fonts name the
    // legacy way (`zdot`), so `nało-enia` and `pienię'ną` read `nałożenia`
    // and `pieniężną`; nothing else in the reading changed.
    expect(digest).toBe(
      "c75a70f07bf9fb4bf8233e263b9f39e506f6832aab76e8a7452c07fe406ca0c7",
    );
    const text = JSON.stringify(lines);
    expect(text).toContain("nałożenia kary pieniężnej");
    expect(text).not.toContain("nało-enia");
  });

  test("the separated reader retains the UOKiK footnote zone as typed lines", async () => {
    const bytes = new Uint8Array(await Bun.file(UOKIK_PDF).arrayBuffer());
    const { notes: lines } = await extractPlPdfSeparatedContent(
      bytes,
      PL_PDF_PARAGRAPH_START.INDENT,
    );
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

const SN_FIXTURE = (name: string): URL =>
  new URL(`__fixtures__/${name}.pdf`, import.meta.url);

const parseSupremeCourtFixture = async (name: string, caseNumber: string) =>
  await parsePlSnDecisionPdf({
    pdfBytes: new Uint8Array(await Bun.file(SN_FIXTURE(name)).arrayBuffer()),
    caseNumber,
    court: "Sąd Najwyższy",
    decisionDate: undefined,
    decisionType: undefined,
    sourceUrl: undefined,
    documentUrl: undefined,
    documentId: name,
  });

/** The decision's stored paragraphs, as the reader and search see them. */
const supremeCourtParagraphs = async (
  name: string,
  caseNumber: string,
): Promise<string[]> =>
  (await parseSupremeCourtFixture(name, caseNumber)).fulltext.split("\n\n");

/** Each superscript in the stored document, with the text set before it. */
const superscriptsOf = (blocks: DocumentAst["blocks"]): string[] => {
  const found: string[] = [];
  const walk = (inlines: readonly Inline[], before: string): string => {
    let text = before;
    for (const inline of inlines) {
      if (inline.type === "text") {
        text += inline.text;
      } else if (inline.type === "superscript") {
        const label = inlinesToPlainText(inline.children);
        found.push(`${text.slice(-12)}^${label}`);
        text += label;
      } else if (hasInlineChildren(inline)) {
        text = walk(inline.children, text);
      }
    }
    return text;
  };
  for (const block of blocks) {
    if ("inlines" in block) {
      walk(block.inlines, "");
    }
  }
  return found;
};

describe("reading recorded Supreme Court PDFs", () => {
  test("a superscript printed above its line is set back after the character it follows", async () => {
    const { documentAst, fulltext } = await parseSupremeCourtFixture(
      "pl-sn-i-csk-2892-23",
      "I CSK 2892/23",
    );

    expect(
      superscriptsOf(documentAst.blocks).some((entry) =>
        entry.endsWith("w art. 398^9"),
      ),
    ).toBe(true);
    expect(
      fulltext.split("\n\n").filter((paragraph) => /^\d+$/u.test(paragraph)),
    ).toEqual([]);
    expect(fulltext).toContain(
      "służy instytucja tzw. przedsądu, ustanowiona w art. 3989 k.p.c.",
    );
  });

  test("a superscript after a line's last word stays at the end of that line", async () => {
    const paragraphs = await supremeCourtParagraphs(
      "pl-sn-v-csk-98-17",
      "V CSK 98/17",
    );

    expect(
      paragraphs.some((paragraph) =>
        paragraph.startsWith(
          "Potrzeba dokonania wykładni przepisów prawnych, przewidziana w art. 3989 § 1 pkt 2 k.p.c.",
        ),
      ),
    ).toBe(true);
    expect(paragraphs.some((paragraph) => /^\d+\s/u.test(paragraph))).toBe(
      false,
    );
  });

  test("a numbered point after a full line ending in a comma opens its own paragraph", async () => {
    const paragraphs = await supremeCourtParagraphs(
      "pl-sn-iii-kk-333-26",
      "III KK 333/26",
    );

    expect(paragraphs).toContain(
      "1. oddalić kasację jako oczywiście bezzasadną,",
    );
    expect(
      paragraphs.some((paragraph) =>
        paragraph.startsWith("2. obciążyć oskarżycielkę posiłkową"),
      ),
    ).toBe(true);
  });

  test("an operative point set as an indented block stays one paragraph", async () => {
    const paragraphs = await supremeCourtParagraphs(
      "pl-sn-i-csk-2892-23",
      "I CSK 2892/23",
    );

    expect(paragraphs).toContain(
      "1. odmawia przyjęcia skargi kasacyjnej do rozpoznania;",
    );
    expect(
      paragraphs.find((paragraph) => paragraph.startsWith("2. zasądza od")),
    ).toEndWith("złotych kosztów postępowania kasacyjnego.");
  });

  test("the running header is dropped and a paragraph runs on over the page break", async () => {
    const paragraphs = await supremeCourtParagraphs(
      "pl-sn-i-csk-2892-23",
      "I CSK 2892/23",
    );

    expect(
      paragraphs.filter((paragraph) => /I CSK 2892\/23\s+\d/u.test(paragraph)),
    ).toEqual([]);
    expect(
      paragraphs.some((paragraph) =>
        paragraph.includes(
          "sprowadzają się do polemiki z zaskarżonym orzeczeniem, nie zaś wykazania",
        ),
      ),
    ).toBe(true);
  });

  test("a hanging-indent list point stays whole and opens its own paragraph", async () => {
    // `2-9` is set with character spacing: each of its glyphs stands a
    // space's width from the next, and none of those gaps is a word space.
    const paragraphs = await supremeCourtParagraphs(
      "pl-sn-iii-kk-499-19",
      "III KK 499/19",
    );

    expect(
      paragraphs.find((paragraph) => paragraph.startsWith("2. czynów")),
    ).toStartWith(
      "2. czynów zarzucanych mu w punktach 2-9 oskarżenia, stanowiących występki z art. 286 § 1 k.k. i ustalając",
    );
    expect(
      paragraphs.some((paragraph) => /;\s*2\. czynów/u.test(paragraph)),
    ).toBe(false);
  });

  test("a word space set by position alone, with no space glyph, still separates the words", async () => {
    // These PDFs print some word spaces only as a gap of 0.16-0.29 em, under
    // the extractor's own 0.3 em, so the text layer ran the words together.
    const ruling = (
      await supremeCourtParagraphs("pl-sn-i-nkrs-75-23", "I NKRS 75/23")
    ).join("\n");
    const appeal = (
      await supremeCourtParagraphs("pl-sn-ii-nsnc-192-24", "II NSNc 192/24")
    ).join("\n");

    expect(ruling).toContain("wniosku o powołanie A. K. (dalej również:");
    expect(ruling).toContain("W ocenie Sądu Najwyższego Krajowa Rada");
    expect(ruling).toContain("przy 8 głosach „wstrzymujących się”");
    expect(ruling).toContain("przez dokonanie oceny kwalifikacji");
    expect(appeal).toContain("zasadę zaufania obywatela do państwa");
    expect(appeal).toContain("(art. 7 w związku z art. 2 Konstytucji RP)");
    expect(appeal).toContain("I NSNc 592/21");
    // Two such spaces in a row, either side of a one-letter word: each is
    // read apart, though the gaps either side of `6` are the same width.
    expect(appeal).toContain("Sądu Najwyższego: z 6 października 2021 r.");
    expect(`${ruling}\n${appeal}`).not.toMatch(/SąduNajwyższego|\p{Ll}\p{Lu}/u);
  });

  // Covers the running-header rule on a second page layout. This fixture
  // prints every word space as a glyph, so it reads the same with or without
  // the positioned spaces above.
  test("the running header is dropped where a sentence runs over the page break", async () => {
    const paragraphs = await supremeCourtParagraphs(
      "pl-sn-i-csk-3410-25",
      "I CSK 3410/25",
    );

    expect(
      paragraphs.filter((paragraph) => /I CSK 3410\/25\s+\d/u.test(paragraph)),
    ).toEqual([]);
    expect(
      paragraphs.some((paragraph) =>
        paragraph.includes(
          "w miejscu pobytu. Jednak rozstrzygnięcie, czy w danej sprawie",
        ),
      ),
    ).toBe(true);
  });

  test("a sentence ending near the margin still ends its paragraph", async () => {
    const paragraphs = await supremeCourtParagraphs(
      "pl-sn-sno-17-17",
      "SNO 17/17",
    );

    expect(paragraphs).toContain(
      "Zażalenia są niezasadne i jako takie nie zasługują na uwzględnienie.",
    );
    expect(
      paragraphs.some((paragraph) =>
        paragraph.startsWith("Istotnie, jak argumentuje się w tych środkach"),
      ),
    ).toBe(true);
  });
});

const TYPESET_SIZE = 12;

/**
 * One shown piece of a typeset line: its weight, the character spacing it is
 * set with (in ems), and its `TJ` array, where a number shifts the next glyph
 * by thousandths of an em (a negative one to the right).
 */
type TypesetPiece = {
  readonly bold?: boolean;
  readonly tracking?: number;
  readonly show: readonly (string | number)[];
};

/** A one-page PDF of Helvetica lines, each shown piece by piece. */
const typesetPdf = async (
  lines: readonly (readonly TypesetPiece[])[],
): Promise<Uint8Array> => {
  const pdf = PDF.create();
  const page = pdf.addPage();
  const regular = page.registerFont("Helvetica");
  const bold = page.registerFont("Helvetica-Bold");
  page.drawOperators(
    lines.flatMap((pieces, index) => [
      ops.beginText(),
      ops.setTextMatrix(1, 0, 0, 1, 72, 700 - index * 2 * TYPESET_SIZE),
      ...pieces.flatMap(({ bold: isBold, tracking = 0, show }) => [
        ops.setFont(isBold === true ? bold : regular, TYPESET_SIZE),
        ops.setCharSpacing(tracking * TYPESET_SIZE),
        ops.showTextArray(
          new PdfArray(
            show.map((item) =>
              typeof item === "string"
                ? PdfString.fromString(item)
                : PdfNumber.of(item),
            ),
          ),
        ),
      ]),
      ops.endText(),
    ]),
  );
  return await pdf.save();
};

/** The text of each line the Supreme Court reading extracts. */
const supremeCourtLineTexts = async (pdfBytes: Uint8Array): Promise<string[]> =>
  (
    await extractPlSnLines(pdfBytes, PL_PDF_PARAGRAPH_START.INDENT, {
      supremeCourt: { docket: "I CSK 1/26" },
    })
  ).flatMap((line) =>
    line.type === "text" ? [line.runs.map(({ text }) => text).join("")] : [],
  );

describe("reading word spaces set by position alone", () => {
  test("a letter-spaced token stays whole where it starts or ends at another font", async () => {
    // `2-9` is bold and set 0.29 em apart, past the 0.11 em a word space
    // needs, between regular glyphs set with none. On the first line the
    // gap after `9` keeps the spacing; on the second `9` is set close.
    // `of the` is spaced by position alone and must still be read apart.
    const lines = await supremeCourtLineTexts(
      await typesetPdf([
        [
          { show: ["in points ("] },
          { bold: true, tracking: 0.29, show: ["2-9"] },
          { show: [") of", -200, "the charge"] },
        ],
        [
          { show: ["in points ("] },
          { bold: true, tracking: 0.29, show: ["2-"] },
          { bold: true, show: ["9"] },
          { show: [") of", -200, "the charge"] },
        ],
      ]),
    );

    expect(lines).toEqual([
      "in points (2-9) of the charge",
      "in points (2-9) of the charge",
    ]);
  });

  test("a document that prints no space glyph is measured against a typographic space", async () => {
    // The extractor itself fills the 0.6 em gap with a space as wide as the
    // gap; taken for the font's space, it would leave the 0.2 em gap joined.
    const lines = await supremeCourtLineTexts(
      await typesetPdf([[{ show: ["foo", -200, "bar", -600, "baz"] }]]),
    );

    expect(lines).toEqual(["foo bar baz"]);
  });
});
