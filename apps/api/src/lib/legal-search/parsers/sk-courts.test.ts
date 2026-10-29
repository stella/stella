/**
 * Which parse failures condemn the document. The deferred-document walk
 * parks a decision on a failure `isUnreadablePdfError` recognises and
 * backs off on any other, so a false positive here turns a parser defect
 * into every decision it touches leaving the walk.
 */

import { PDF, StandardFonts } from "@libpdf/core";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { documentAstSchema } from "@stll/legal-ast/document-ast";

import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { markupResidueIn } from "@/api/lib/legal-search/parsers/markup-residue";
import {
  buildSkDecisionPdfBlocks,
  isUnreadablePdfError,
  parseSkDecisionPdf as uncheckedParseSkDecisionPdf,
} from "@/api/lib/legal-search/parsers/sk-courts";
import { guardParser } from "@/api/tests/helpers/parser-reader-guard";

const parseSkDecisionPdf = guardParser(uncheckedParseSkDecisionPdf);

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

/** What parsing these bytes rejected with; a resolution fails the test. */
const parseFailure = async (pdfBytes: Uint8Array): Promise<unknown> =>
  await parseSkDecisionPdf({
    pdfBytes,
    caseNumber: "1Cdo/1/2026",
    ecli: undefined,
    court: "Najvyšší súd Slovenskej republiky",
    decisionDate: undefined,
    decisionType: undefined,
  }).then(
    () => new Error("expected the parse to fail"),
    (error: unknown) => error,
  );

describe("unreadable PDF failures", () => {
  test("libpdf's verdict on bytes it cannot recover is recognised", async () => {
    // Read from the real library rather than constructed here, so a
    // renamed error upstream fails this test instead of silently
    // sending every corrupt download down the backoff path.
    for (const bytes of [
      encode("%PDF-1.7 not a pdf"),
      encode("%PDF-1.4\n"),
      new Uint8Array(0),
    ]) {
      const failure = await parseFailure(bytes);

      expect(failure).toBeInstanceOf(Error);
      expect(isUnreadablePdfError(failure)).toBe(true);
    }
  });

  test("a failure libpdf does not attribute to the bytes is not recognised", async () => {
    // A PDF whose catalog points at a missing page tree: libpdf throws a
    // plain Error, which says nothing about whether the next document
    // would fail the same way.
    const unattributed = await parseFailure(
      encode("%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"),
    );
    expect(unattributed).toBeInstanceOf(Error);

    for (const failure of [
      unattributed,
      new TypeError("Cannot read properties of undefined"),
      new RangeError("Maximum call stack size exceeded"),
      new AdapterFetchError({
        message: "Document fetch returned 503",
        adapterKey: "sk-courts",
        cursor: null,
      }),
      "UnrecoverableParseError",
      undefined,
    ]) {
      expect(isUnreadablePdfError(failure)).toBe(false);
    }
  });
});

describe("PDF source line retention", () => {
  test("keeps anonymized PDF segments and printed placeholders in the AST", () => {
    for (const placeholder of ["anonymizované", "[anonymizované]", "J. N."]) {
      const text = `Sťažovateľ ${placeholder} podal návrh.`;
      const blocks = buildSkDecisionPdfBlocks({
        lines: [
          {
            text,
            segments: [
              { text: "Sťažovateľ" },
              { text: placeholder, anonymized: true },
              { text: "podal návrh." },
            ],
            bold: false,
            fontSize: 10,
            pageIndex: 0,
          },
        ],
        metadata: { court: "Court", caseNumber: "1/2026", ecli: undefined },
      });

      expect(blocks.map((block) => block.plainText).join("\n")).toBe(text);
      expect(blocks).toHaveLength(1);
      expect(blocks.at(0)).toMatchObject({
        type: "paragraph",
        inlines: expect.arrayContaining([
          { type: "text", text: placeholder, anonymized: true },
        ]),
      });
    }
  });

  const blocksFrom = (texts: string[]) =>
    buildSkDecisionPdfBlocks({
      lines: texts.map((text) => ({
        text,
        segments: [{ text }],
        bold: false,
        fontSize: 10,
        pageIndex: 0,
      })),
      metadata: { court: "Court", caseNumber: "1/2026", ecli: undefined },
    });

  test("strips only a matching standalone header before merging body lines", () => {
    const blocks = blocksFrom(["Súd: Court", "The body survives."]);
    expect(blocks.map((block) => block.plainText).join(" ")).toBe(
      "The body survives.",
    );
  });

  test("keeps a header label followed by body text or a different source value", () => {
    for (const text of ["Súd: Court The body survives.", "Súd: Other court"]) {
      expect(
        blocksFrom([text])
          .map((block) => block.plainText)
          .join(" "),
      ).toBe(text);
    }
  });

  test("keeps digit-only amounts and numbered points at page boundaries", () => {
    for (const texts of [["1234", "Body"], ["Body", "1234"], ["1"]]) {
      expect(
        blocksFrom(texts)
          .map((block) => block.plainText)
          .join(" "),
      ).toBe(texts.join(" "));
    }
  });

  test("keeps digit-only text after a closing formula", () => {
    const lines = [
      {
        text: "Poučenie:",
        segments: [{ text: "Poučenie:" }],
        bold: true,
        fontSize: 10,
        pageIndex: 0,
      },
      {
        text: "V Bratislave dňa 1. januára 2026",
        segments: [{ text: "V Bratislave dňa 1. januára 2026" }],
        bold: false,
        fontSize: 10,
        pageIndex: 0,
      },
      {
        text: "123",
        segments: [{ text: "123" }],
        bold: true,
        fontSize: 11,
        pageIndex: 0,
      },
    ];
    const blocks = buildSkDecisionPdfBlocks({
      lines,
      metadata: { court: "Court", caseNumber: "1/2026", ecli: undefined },
    });
    expect(blocks.find((block) => block.plainText === "123")).toMatchObject({
      type: "paragraph",
      role: "signature",
    });
  });
});

describe("PDF byte fixture text retention", () => {
  const parseLines = async (texts: string[]) => {
    const pdf = PDF.create();
    const page = pdf.addPage({ size: "letter" });
    for (const [index, text] of texts.entries()) {
      page.drawText(text, { x: 70, y: 700 - index * 20, size: 10 });
    }
    return await parseSkDecisionPdf({
      pdfBytes: await pdf.save(),
      caseNumber: "1/2026",
      ecli: "ECLI:SK:TEST:2026:1",
      court: "Court",
      decisionDate: undefined,
      decisionType: undefined,
    });
  };

  test("does not discard body text merged after a metadata header", async () => {
    const { fulltext } = await parseLines([
      "ECLI: ECLI:SK:TEST:2026:1",
      "The body survives.",
    ]);
    expect(fulltext).toBe("The body survives.");
  });

  test("keeps numeric content through extraction at either page boundary", async () => {
    for (const texts of [["1234", "Body"], ["Body", "1234"], ["1"]]) {
      const { fulltext } = await parseLines(texts);
      expect(fulltext.replaceAll(/\s+/gu, " ")).toBe(texts.join(" "));
    }
  });

  test("keeps an unknown publisher literal as ordinary text", async () => {
    const { fulltext } = await parseLines(["fe&ion;"]);

    expect(fulltext).toBe("fe&ion;");
    expect(markupResidueIn(fulltext)).toBeUndefined();
  });

  test("still reports recognized references left in PDF text", async () => {
    for (const reference of ["&amp;amp;", "&eacute;"]) {
      const { fulltext } = await parseLines([reference]);

      expect(fulltext).toContain(reference);
      expect(markupResidueIn(fulltext)).toMatchObject({
        rule: "entity",
        excerpt: reference,
      });
    }
  });
});

test("bold Roman verdict items keep their holding role and reasoning titles become headings", async () => {
  const pdf = PDF.create();
  const page = pdf.addPage({ size: "letter" });
  const lines = [
    { text: "rozhodol:", font: StandardFonts.HelveticaBold },
    { text: "I. Súd žalobu zamieta.", font: StandardFonts.HelveticaBold },
    { text: "II. Náhradu nepriznáva.", font: StandardFonts.HelveticaBold },
    { text: "Odôvodnenie:", font: StandardFonts.HelveticaBold },
    { text: "Text odovodnenia.", font: StandardFonts.Helvetica },
    { text: "XII. Argumentacia", font: StandardFonts.HelveticaBold },
    { text: "Dalsi text.", font: StandardFonts.Helvetica },
  ];
  for (const [index, line] of lines.entries()) {
    page.drawText(line.text, {
      x: 50,
      y: 700 - index * 20,
      size: 10,
      font: line.font,
    });
  }
  const { documentAst } = await parseSkDecisionPdf({
    pdfBytes: await pdf.save(),
    caseNumber: "1C/1/2024",
    ecli: undefined,
    court: "Okresný súd",
    decisionDate: undefined,
    decisionType: undefined,
  });
  for (const text of ["I. Súd žalobu zamieta.", "II. Náhradu nepriznáva."]) {
    expect(
      documentAst.blocks.find((block) => block.plainText === text),
    ).toMatchObject({ type: "paragraph", role: "holding" });
  }
  expect(
    documentAst.blocks.find((block) => block.plainText === "XII. Argumentacia"),
  ).toMatchObject({ type: "heading", level: 3 });
});

describe("reader-compatible Slovak heading identities", () => {
  const build = (texts: string[]) => {
    const blocks = buildSkDecisionPdfBlocks({
      lines: texts.map((text) => ({
        text,
        segments: [{ text, bold: true }],
        bold: true,
        fontSize: text === text.toUpperCase() ? 20 : 10,
        pageIndex: 0,
      })),
      metadata: { court: "Court", caseNumber: "1/2026", ecli: undefined },
    });
    return {
      version: 1,
      source: {
        system: "test",
        documentId: "synthetic",
        webUrl: "",
        printUrl: "",
      },
      metadata: {
        caseNumber: "1/2026",
        ecli: null,
        court: "Court",
        decisionDate: null,
        decisionType: null,
        keywords: [],
        statutes: [],
      },
      blocks,
    };
  };

  test("consecutive bold title lines form one reader heading", () => {
    const ast = build(["ROZSUDOK V MENE", "SLOVENSKEJ REPUBLIKY", "rozhodol:"]);
    expect(
      ast.blocks.filter(
        (block) => block.type === "heading" && block.role === "decision-title",
      ),
    ).toMatchObject([
      {
        type: "heading",
        anchorId: "h-title",
        plainText: "ROZSUDOK V MENE SLOVENSKEJ REPUBLIKY",
      },
    ]);
    expect(v.safeParse(documentAstSchema, ast).success).toBe(true);
  });

  test("repeated fixed section anchors remain unique for the reader", () => {
    const ast = build([
      "ROZSUDOK",
      "Preamble",
      "UZNESENIE",
      "rozhodol:",
      "Holding",
      "rozhodol:",
      "Odôvodnenie:",
      "Reasoning",
      "Odôvodnenie:",
      "Poučenie:",
      "Instruction",
      "Poučenie:",
    ]);
    const anchors = ast.blocks.map((block) => block.anchorId);
    expect(new Set(anchors).size).toBe(anchors.length);
    expect(
      ast.blocks
        .filter((block) => block.type === "heading")
        .map((block) => block.anchorId),
    ).toEqual([
      "h-title",
      "h-title-2",
      "h-holding",
      "h-holding-2",
      "h-reasoning",
      "h-reasoning-2",
      "h-instruction",
      "h-instruction-2",
    ]);
    expect(v.safeParse(documentAstSchema, ast).success).toBe(true);
  });
});

describe("paragraphs across the PDF's line wraps", () => {
  type Line = { text: string; bold?: boolean; fontSize?: number };
  const plain = (text: string): Line => ({ text });
  const bold = (text: string): Line => ({ text, bold: true });

  /**
   * A general-court resolution as libpdf reads it: one line per printed
   * line, justified near column 80. Written for this test in the court's
   * register; not a real decision.
   */
  const RESOLUTION: readonly Line[] = [
    { text: "Uznesenie", fontSize: 20 },
    plain(
      "Okresný súd Mesto v exekučnej veci oprávneného: Firma, s. r. o., so sídlom",
    ),
    plain(
      "Mesto, Hlavná 1, proti povinnému: A. B., bytom Mesto, o vymoženie sumy 1 000",
    ),
    plain(
      "eur s príslušenstvom, vedenej u súdneho exekútora so sídlom v Meste, ktorým je",
    ),
    plain(
      "JUDr. Adam Vzorový, pod sp. zn. EX 100/2003, o návrhu povinného na zastavenie",
    ),
    plain("exekúcie, takto"),
    bold("r o z h o d o l :"),
    plain("Exekúciu z a s t a v u j e ."),
    bold("o d ô v o d n e n i e :"),
    plain(
      "1. Na základe poverenia na vykonanie exekúcie, ktoré súd vydal dňa 22.",
    ),
    plain(
      "10. 2003, začal súdny exekútor exekúciu na vymoženie pohľadávky oprávneného.",
    ),
    plain(
      "2. Povinný podal návrh na zastavenie exekúcie, ktorý odôvodnil tým, že jeho",
    ),
    plain(
      "pohľadávka zanikla zaplatením ešte pred začatím exekúcie, čo preukázal v bode",
    ),
    plain("22."),
    plain(
      "3. Súd návrhu vyhovel, lebo pohľadávka bola zaplatená, a exekúciu zastavil.",
    ),
    bold("P o u č e n i e :"),
    plain(
      "Proti tomuto uzneseniu je prípustné odvolanie do pätnástich dní odo dňa jeho",
    ),
    plain("doručenia na súd, ktorý rozhodnutie vydal."),
    plain("V Meste dňa 1. februára 2004"),
    plain("JUDr. Ivana Vzorová"),
    plain("sudkyňa"),
  ];

  const blocksOf = (lines: readonly Line[]) =>
    buildSkDecisionPdfBlocks({
      lines: lines.map(
        ({ text, bold: isBold = false, fontSize = 10 }, index) => ({
          text,
          segments: [isBold ? { text, bold: true } : { text }],
          bold: isBold,
          fontSize,
          pageIndex: 0,
          layout: {
            x: 70,
            y: 700 - index * 14,
            height: 10,
            width: text.length * 5,
            pageIndex: 0,
          },
        }),
      ),
      metadata: {
        court: "Okresný súd Mesto",
        caseNumber: "1Er/1/2003",
        ecli: undefined,
      },
    });

  test("a sentence wrapped before an academic title stays one paragraph", () => {
    const intro = blocksOf(RESOLUTION).find((block) =>
      block.plainText.startsWith("Okresný súd Mesto"),
    );
    expect(intro?.plainText).toBe(
      "Okresný súd Mesto v exekučnej veci oprávneného: Firma, s. r. o., so sídlom Mesto, Hlavná 1, proti povinnému: A. B., bytom Mesto, o vymoženie sumy 1 000 eur s príslušenstvom, vedenej u súdneho exekútora so sídlom v Meste, ktorým je JUDr. Adam Vzorový, pod sp. zn. EX 100/2003, o návrhu povinného na zastavenie exekúcie, takto",
    );
  });

  test("a date wrapped after its day stays in its paragraph and opens no point", () => {
    const blocks = blocksOf(RESOLUTION);
    expect(
      blocks.find((block) => block.plainText.startsWith("1. ")),
    ).toMatchObject({
      type: "paragraph",
      plainText:
        "1. Na základe poverenia na vykonanie exekúcie, ktoré súd vydal dňa 22. 10. 2003, začal súdny exekútor exekúciu na vymoženie pohľadávky oprávneného.",
    });
    expect(blocks.some((block) => block.plainText.startsWith("10. 2003"))).toBe(
      false,
    );
  });

  test("numbered points, the closing formula and the signature stay apart", () => {
    const texts = blocksOf(RESOLUTION).map((block) => block.plainText);
    expect(texts.slice(-8)).toEqual([
      "o d ô v o d n e n i e :",
      "1. Na základe poverenia na vykonanie exekúcie, ktoré súd vydal dňa 22. 10. 2003, začal súdny exekútor exekúciu na vymoženie pohľadávky oprávneného.",
      "2. Povinný podal návrh na zastavenie exekúcie, ktorý odôvodnil tým, že jeho pohľadávka zanikla zaplatením ešte pred začatím exekúcie, čo preukázal v bode 22.",
      "3. Súd návrhu vyhovel, lebo pohľadávka bola zaplatená, a exekúciu zastavil.",
      "P o u č e n i e :",
      "Proti tomuto uzneseniu je prípustné odvolanie do pätnástich dní odo dňa jeho doručenia na súd, ktorý rozhodnutie vydal.",
      "V Meste dňa 1. februára 2004",
      "JUDr. Ivana Vzorová sudkyňa",
    ]);
  });

  test("a numbered point after a day number at a full line's end stays a point", () => {
    const point =
      "10. Súd ďalej uvádza, že oprávnený sa k návrhu povinného nijako nevyjadril.";
    const texts = blocksOf([
      ...RESOLUTION.slice(0, 9),
      plain(
        "1. Exekútor začal exekúciu a povinný sa k nej vyjadril tak, ako uvádza bod 22.",
      ),
      plain(point),
    ]).map((block) => block.plainText);
    expect(texts.at(-1)).toBe(point);
  });

  const PROSE = Array.from({ length: 8 }, () =>
    plain(
      "Súd uviedol všetky rozhodujúce skutkové okolnosti a vykonal dokazovanie",
    ),
  );

  test("numbered points opening in lowercase stay apart", () => {
    const first =
      "1. žalovaný je povinný zaplatiť žalobcovi trovy konania vo výške 100 eur";
    const second =
      "2. žalobcovi sa priznáva právo na náhradu trov odvolacieho konania";
    const texts = blocksOf([
      ...PROSE,
      bold("rozhodol:"),
      plain(first),
      plain(second),
    ]).map((block) => block.plainText);
    expect(texts.slice(-2)).toEqual([first, second]);
  });

  test("the next point in sequence opening with a year stays a point", () => {
    const ninth =
      "9. Súd posúdil námietku tak, ako ju oprávnený uviedol vo svojom bode 22.";
    const tenth =
      "10. 2023 bol rokom, v ktorom došlo k zaplateniu celej dlžnej sumy.";
    const texts = blocksOf([
      ...PROSE,
      bold("rozhodol:"),
      plain(ninth),
      plain(tenth),
    ]).map((block) => block.plainText);
    expect(texts.slice(-2)).toEqual([ninth, tenth]);
  });

  test("a signature after the closing date stays a signature", () => {
    const blocks = blocksOf([
      ...Array.from({ length: 8 }, () =>
        plain("Súd vo veci vykonal dokazovanie a zistil"),
      ),
      bold("Poučenie:"),
      plain("Odvolanie sa podáva do pätnástich dní."),
      plain("V Bratislave dňa 30. septembra 2026"),
      plain("JUDr. Jana Novotná, predsedníčka senátu"),
    ]);
    expect(
      blocks.slice(-2).map(({ plainText, ...block }) => ({
        plainText,
        role: "role" in block ? block.role : undefined,
      })),
    ).toEqual([
      { plainText: "V Bratislave dňa 30. septembra 2026", role: "closing" },
      {
        plainText: "JUDr. Jana Novotná, predsedníčka senátu",
        role: "signature",
      },
    ]);
  });

  test("a point out of sequence opening in lowercase stays a point", () => {
    const first =
      "1. žalovaný je povinný zaplatiť žalobcovi trovy konania vo výške 100 eur";
    const third =
      "3. žalobcovi sa priznáva právo na náhradu trov odvolacieho konania";
    const texts = blocksOf([
      ...PROSE,
      bold("rozhodol:"),
      plain(first),
      plain(third),
    ]).map((block) => block.plainText);
    expect(texts.slice(-2)).toEqual([first, third]);
  });

  test("signatures after a closing formula stay apart in any section", () => {
    const signatures = [
      "V Bratislave dňa 30. septembra 2026",
      "JUDr. Jana Novotná, predsedníčka senátu",
      "JUDr. Adam Vzorový, člen senátu",
    ];
    const texts = blocksOf([
      ...Array.from({ length: 8 }, () =>
        plain("Súd vo veci vykonal dokazovanie a zistil"),
      ),
      bold("Odôvodnenie:"),
      ...signatures.map(plain),
    ]).map((block) => block.plainText);
    expect(texts.slice(-3)).toEqual(signatures);
  });

  test("a January date split after its day stays in its point", () => {
    const texts = blocksOf([
      ...PROSE,
      bold("Odôvodnenie:"),
      plain(
        "1. Na základe poverenia na vykonanie exekúcie, ktoré súd vydal dňa 22.",
      ),
      plain(
        "2. 2003, začal súdny exekútor exekúciu na vymoženie pohľadávky oprávneného.",
      ),
    ]).map((block) => block.plainText);
    expect(texts.at(-1)).toBe(
      "1. Na základe poverenia na vykonanie exekúcie, ktoré súd vydal dňa 22. 2. 2003, začal súdny exekútor exekúciu na vymoženie pohľadávky oprávneného.",
    );
  });
});

describe("unnumbered PDF paragraph boundaries", () => {
  test.each([
    {
      signal: "short final line before a capitalised sentence",
      first: "The first paragraph ends.",
      next: "Another paragraph starts with the evidence that the court considered.",
      x: 70,
      y: 686,
    },
    {
      signal: "short final line without terminal punctuation",
      first: "The first paragraph ends here",
      next: "Another paragraph starts with the evidence that the court considered.",
      x: 70,
      y: 686,
    },
    {
      signal: "indent",
      first: "The first paragraph ends here",
      next: "another paragraph starts here",
      x: 90,
      y: 686,
    },
    {
      signal: "vertical gap",
      first: "The first paragraph ends here",
      next: "another paragraph starts here",
      x: 70,
      y: 670,
    },
  ])(
    "preserves two paragraphs separated by $signal",
    async ({ first, next, x, y }) => {
      const pdf = PDF.create();
      const page = pdf.addPage({ size: "letter" });
      page.drawText(first, { x: 70, y: 700, size: 10 });
      page.drawText(next, { x, y, size: 10 });
      const { documentAst } = await parseSkDecisionPdf({
        pdfBytes: await pdf.save(),
        caseNumber: "1/2026",
        court: "Court",
        ecli: undefined,
        decisionDate: undefined,
        decisionType: undefined,
      });
      expect(
        documentAst.blocks
          .filter((block) => block.type === "paragraph")
          .map((block) => block.plainText),
      ).toEqual([first, next]);
    },
  );

  test.each([{ pitch: 14 }, { pitch: 18 }])(
    "sentences at a full printed line boundary stay in one paragraph (pitch $pitch)",
    async ({ pitch }) => {
      const pdf = PDF.create();
      const page = pdf.addPage({ size: "letter" });
      const first = "The court considered the application.";
      const next = "The court rejected the application.";
      page.drawText(first, { x: 70, y: 700, size: 10 });
      page.drawText(next, { x: 70, y: 700 - pitch, size: 10 });
      const { documentAst } = await parseSkDecisionPdf({
        pdfBytes: await pdf.save(),
        caseNumber: "1/2026",
        court: "Court",
        ecli: undefined,
        decisionDate: undefined,
        decisionType: undefined,
      });
      expect(documentAst.blocks.map((block) => block.plainText)).toEqual([
        `${first} ${next}`,
      ]);
    },
  );

  test("an established wide line pitch keeps a multi-sentence paragraph together", async () => {
    const pdf = PDF.create();
    const page = pdf.addPage({ size: "letter" });
    const text = "The court considered the application.";
    for (const y of [700, 670, 640]) {
      page.drawText(text, { x: 70, y, size: 10 });
    }
    const { documentAst } = await parseSkDecisionPdf({
      pdfBytes: await pdf.save(),
      caseNumber: "1/2026",
      court: "Court",
      ecli: undefined,
      decisionDate: undefined,
      decisionType: undefined,
    });
    expect(documentAst.blocks.map((block) => block.plainText)).toEqual([
      `${text} ${text} ${text}`,
    ]);
  });

  test("a paragraph gap is measured against the page's ordinary line pitch", async () => {
    const pdf = PDF.create();
    const page = pdf.addPage({ size: "letter" });
    const first = "The court considered the application";
    const second = "and reviewed the evidence presented";
    const next = "another paragraph explains the decision";
    page.drawText(first, { x: 70, y: 700, size: 10 });
    page.drawText(second, { x: 70, y: 686, size: 10 });
    page.drawText(next, { x: 70, y: 666, size: 10 });
    const { documentAst } = await parseSkDecisionPdf({
      pdfBytes: await pdf.save(),
      caseNumber: "1/2026",
      court: "Court",
      ecli: undefined,
      decisionDate: undefined,
      decisionType: undefined,
    });
    expect(documentAst.blocks.map((block) => block.plainText)).toEqual([
      `${first} ${second}`,
      next,
    ]);
  });

  test("keeps a name after its academic title and a bold continuation inside the paragraph", async () => {
    const pdf = PDF.create();
    const page = pdf.addPage({ size: "letter" });
    page.drawText("The application was filed by JUDr.", {
      x: 70,
      y: 700,
      size: 10,
    });
    page.drawText("Adam Example and the court", { x: 70, y: 686, size: 10 });
    page.drawText("granted it.", {
      x: 70,
      y: 672,
      size: 10,
      font: StandardFonts.HelveticaBold,
    });
    const { documentAst } = await parseSkDecisionPdf({
      pdfBytes: await pdf.save(),
      caseNumber: "1/2026",
      court: "Court",
      ecli: undefined,
      decisionDate: undefined,
      decisionType: undefined,
    });
    expect(documentAst.blocks.map((block) => block.plainText)).toEqual([
      "The application was filed by JUDr. Adam Example and the court granted it.",
    ]);
  });

  test("joins lines inside one paragraph from their PDF geometry", async () => {
    const pdf = PDF.create();
    const page = pdf.addPage({ size: "letter" });
    page.drawText("The court considered the", { x: 70, y: 700, size: 10 });
    page.drawText("application before it.", { x: 70, y: 686, size: 10 });
    const { documentAst } = await parseSkDecisionPdf({
      pdfBytes: await pdf.save(),
      caseNumber: "1/2026",
      court: "Court",
      ecli: undefined,
      decisionDate: undefined,
      decisionType: undefined,
    });
    expect(documentAst.blocks.map((block) => block.plainText)).toEqual([
      "The court considered the application before it.",
    ]);
  });
});
