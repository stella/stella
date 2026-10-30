import { ops, PDF, PdfString } from "@libpdf/core";
import { describe, expect, test } from "bun:test";

import { hasBlockInlines } from "@stll/legal-ast/document-ast";
import type { Inline } from "@stll/legal-ast/document-ast";
import { hasInlineChildren } from "@stll/legal-ast/inline";
import { sha256Hex } from "@stll/sha256/bun";

import {
  extractPlSnLines,
  parsePlSnDecisionPdf,
  PL_PDF_PARAGRAPH_START,
} from "@/api/handlers/case-law/ingestion/parsers/pl-sn";
import { inlinesToPlainText } from "@/api/handlers/case-law/ingestion/parsers/shared-inlines";

import provenance from "./__fixtures__/pl-sn-ii-cskp-1456-22.pdf.provenance.json";

const CASE_NUMBER = "II CSKP 1456/22";
const FIXTURE = new URL(
  "__fixtures__/pl-sn-ii-cskp-1456-22.pdf",
  import.meta.url,
);
const SIGNATORIES = "Monika Koba Dariusz Dończyk Marta Romańska";
const RULING_ITEM_TWO =
  "2) zasądza od pozwanej na rzecz powódek kwotę 5.400 (pięć tysięcy czterysta) zł z odsetkami w wysokości odsetek ustawowych za opóźnienie w spełnieniu świadczenia pieniężnego za czas po upływie tygodnia od doręczenia pozwanej odpisu niniejszego orzeczenia.";

const readDecision = async () => {
  const pdfBytes = new Uint8Array(await Bun.file(FIXTURE).arrayBuffer());
  return await parsePlSnDecisionPdf({
    pdfBytes,
    caseNumber: CASE_NUMBER,
    court: "Sąd Najwyższy",
    decisionDate: "2024-05-09",
    decisionType: "Wyrok",
    sourceUrl: undefined,
    documentUrl: undefined,
    documentId: "pl-sn-ii-cskp-1456-22",
  });
};

const superscriptTexts = (inlines: readonly Inline[]): string[] =>
  inlines.flatMap((inline) => {
    if (inline.type === "superscript") {
      return [inlinesToPlainText(inline.children)];
    }
    return hasInlineChildren(inline) ? superscriptTexts(inline.children) : [];
  });

describe("reading the recorded II CSKP 1456/22 decision", () => {
  test("the retained PDF matches its recorded provenance", async () => {
    const bytes = new Uint8Array(await Bun.file(FIXTURE).arrayBuffer());
    expect(sha256Hex(bytes)).toBe(provenance.sha256);
  });

  test("opening matter precedes two complete operative items and the signatures", async () => {
    const { documentAst } = await readDecision();
    const blocks = documentAst.blocks.filter(hasBlockInlines);
    expect(blocks).toHaveLength(documentAst.blocks.length);
    expect(
      blocks.slice(0, 11).map((block) => ({
        type: block.type,
        role: block.role,
        text: block.plainText,
      })),
    ).toEqual([
      { type: "paragraph", role: "case-number", text: CASE_NUMBER },
      { type: "heading", role: "decision-title", text: "WYROK" },
      {
        type: "paragraph",
        role: "intro",
        text: "W IMIENIU RZECZYPOSPOLITEJ POLSKIEJ",
      },
      {
        type: "paragraph",
        role: "intro",
        text: "9 maja 2024 r. Sąd Najwyższy w Izbie Cywilnej w składzie:",
      },
      {
        type: "paragraph",
        role: "panel",
        text: "SSN Dariusz Dończyk (przewodniczący)",
      },
      {
        type: "paragraph",
        role: "panel",
        text: "SSN Marta Romańska (sprawozdawca)",
      },
      { type: "paragraph", role: "panel", text: "SSN Monika Koba" },
      {
        type: "paragraph",
        role: "intro",
        text: "po rozpoznaniu na posiedzeniu niejawnym 9 maja 2024 r. w Warszawie skargi kasacyjnej R. spółki z ograniczoną odpowiedzialnością w likwidacji w K. od wyroku Sądu Apelacyjnego w Krakowie z 16 lutego 2021 r., I AGa 203/19, w sprawie z powództwa A. W. i I. W. przeciwko R. spółce z ograniczoną odpowiedzialnością w likwidacji w K. o zapłatę,",
      },
      {
        type: "paragraph",
        role: "holding",
        text: "1) oddala skargę kasacyjną;",
      },
      { type: "paragraph", role: "holding", text: RULING_ITEM_TWO },
      {
        type: "paragraph",
        role: "signature",
        text: `${SIGNATORIES} [SOP]`,
      },
    ]);
    const operative = blocks.filter((block) => block.role === "holding");
    expect(operative.map((block) => block.plainText)).toEqual([
      "1) oddala skargę kasacyjną;",
      RULING_ITEM_TWO,
    ]);
    expect(operative.at(1)?.inlines).toEqual([
      { type: "bold", children: [{ type: "text", text: RULING_ITEM_TWO }] },
    ]);
    expect(blocks.at(-1)?.role).toBe("signature");
    expect(blocks.at(-1)?.plainText).toBe(SIGNATORIES);
  });

  test("page furniture never enters body text or separates continued paragraphs", async () => {
    const { documentAst, fulltext } = await readDecision();
    const paragraphs = documentAst.blocks
      .filter((block) => block.type === "paragraph")
      .map((block) => block.plainText);
    expect(paragraphs.filter((text) => text.includes(CASE_NUMBER))).toEqual([
      CASE_NUMBER,
    ]);
    expect(fulltext).not.toMatch(/II CSKP 1456\/22\s+\d/u);
    const continuations = [
      "naruszenia § 3 ust. 3 umowy inwestycyjnej i 28 maja 2018 r. wezwała",
      "działalności gospodarczej w ramach B. spółki z ograniczoną odpowiedzialnością",
      "postanowienia zawartego w § 3 ust. 3 umowy inwestycyjnej, jako sprzecznego",
      "szczegółowo wypowiedział się w m.in. wyroku",
      "W niniejszej sprawie było nim zobowiązanie",
      "lecz i osób trzecich wchodzących ze spółką",
      "powódki, nieuczestniczące w działalności gospodarczej mężów",
    ];
    for (const continuation of continuations) {
      expect(
        paragraphs.filter((text) => text.includes(continuation)),
      ).toHaveLength(1);
    }
    expect(paragraphs.some((text) => /^7\s/u.test(text))).toBe(false);
  });

  test("Latin emphasis remains inside its reasoning paragraph", async () => {
    const { documentAst } = await readDecision();
    const paragraph = documentAst.blocks
      .filter(hasBlockInlines)
      .find((block) =>
        block.plainText.startsWith("Do zawarcia umowy dochodzi"),
      );
    expect(paragraph?.plainText).toEndWith(
      "zredagowała tekst je wywołujący (in dubio contra proferentem).",
    );
    expect(paragraph?.inlines).toContainEqual({
      type: "italic",
      children: [{ type: "text", text: "in dubio contra proferentem" }],
    });
    const finalReasoning = documentAst.blocks
      .filter(hasBlockInlines)
      .find((block) =>
        block.plainText.startsWith("Z ustaleń Sądu Apelacyjnego wynika"),
      );
    expect(finalReasoning?.plainText).toContain(
      "Sądy meriti nie czyniły stosownych ustaleń",
    );
    expect(finalReasoning?.inlines).toContainEqual({
      type: "italic",
      children: [{ type: "text", text: "meriti " }],
    });
  });

  test("raised article indices remain inline rather than opening continuation paragraphs", async () => {
    const { documentAst } = await readDecision();
    for (const [opening, continuation] of [
      [
        "Zdaniem Sądu Okręgowego",
        "jest nieważne, jako sprzeczne z art. 1097 § 1 k.c.",
      ],
      [
        "Sąd Apelacyjny przyjął",
        "Pozwana nie kwestionowała bowiem sposobu wykładani art. 1097 k.c.",
      ],
    ] as const) {
      const paragraph = documentAst.blocks
        .filter(hasBlockInlines)
        .find((block) => block.plainText.startsWith(opening));
      expect(paragraph?.plainText).toContain(continuation);
      expect(superscriptTexts(paragraph?.inlines ?? [])).toEqual(["7"]);
    }
  });
});

const runningHeaderPdf = async (docket: string, pageCount: number) => {
  const pdf = PDF.create();
  for (let index = 0; index < pageCount; index += 1) {
    const page = pdf.addPage();
    const font = page.registerFont("Helvetica");
    const header = index === 0 ? docket : `${docket} ${index + 1}`;
    const sentence = `The decision ${docket} ${index + 1} remains cited in this sentence.`;
    page.drawOperators([
      ops.beginText(),
      ops.setFont(font, 12),
      ops.setTextMatrix(1, 0, 0, 1, 72, page.height - 40),
      ops.showText(PdfString.fromString(header)),
      ops.endText(),
      ops.beginText(),
      ops.setFont(font, 12),
      ops.setTextMatrix(1, 0, 0, 1, 72, page.height - 110),
      ops.showText(PdfString.fromString(sentence)),
      ops.endText(),
    ]);
  }
  return await pdf.save();
};

describe("recognising running docket furniture by page position", () => {
  test.each([
    { docket: "I CSK 12/26", pages: 2 },
    { docket: "III KK 101/23", pages: 3 },
    { docket: "II CSKP 987/22", pages: 7 },
  ])(
    "removes running headers across $pages pages for $docket and retains the same label in sentences",
    async ({ docket, pages }) => {
      const lines = await extractPlSnLines(
        await runningHeaderPdf(docket, pages),
        PL_PDF_PARAGRAPH_START.INDENT,
        { supremeCourt: { docket } },
      );
      const texts = lines.flatMap((line) =>
        line.type === "text"
          ? [line.runs.map(({ text }) => text).join("")]
          : [],
      );
      expect(texts).toEqual([
        docket,
        ...Array.from(
          { length: pages },
          (_, index) =>
            `The decision ${docket} ${index + 1} remains cited in this sentence.`,
        ),
      ]);
    },
  );
});
