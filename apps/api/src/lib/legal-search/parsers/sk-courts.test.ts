/**
 * Which parse failures condemn the document. The deferred-document walk
 * parks a decision on a failure `isUnreadablePdfError` recognises and
 * backs off on any other, so a false positive here turns a parser defect
 * into every decision it touches leaving the walk.
 */

import { PDF, StandardFonts } from "@libpdf/core";
import { describe, expect, test } from "bun:test";

import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import {
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
