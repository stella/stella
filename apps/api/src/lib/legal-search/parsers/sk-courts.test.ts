/**
 * Which parse failures condemn the document. The deferred-document walk
 * parks a decision on a failure `isUnreadablePdfError` recognises and
 * backs off on any other, so a false positive here turns a parser defect
 * into every decision it touches leaving the walk.
 */

import { PDF, StandardFonts } from "@libpdf/core";
import { describe, expect, test } from "bun:test";

import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { markupResidueIn } from "@/api/lib/legal-search/parsers/markup-residue";
import {
  buildSkDecisionPdfBlocks,
  isUnreadablePdfError,
  parseSkDecisionPdf,
} from "@/api/lib/legal-search/parsers/sk-courts";

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
      expect(fulltext).toBe(texts.join(" "));
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
      lines: lines.map(({ text, bold: isBold = false, fontSize = 10 }) => ({
        text,
        segments: [isBold ? { text, bold: true } : { text }],
        bold: isBold,
        fontSize,
        pageIndex: 0,
      })),
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
});
