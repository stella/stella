import { PDF, StandardFonts } from "@libpdf/core";
import { describe, expect, test } from "bun:test";

import { RETENTION_PROJECTION_FAILURE } from "@/api/handlers/case-law/ingestion/retention/retention-policy";
import { projectSkCourtsDocument } from "@/api/handlers/case-law/ingestion/retention/sources/sk-courts-document";
import { parseSkDecisionPdf as uncheckedParseSkDecisionPdf } from "@/api/lib/legal-search/parsers/sk-courts";
import {
  validateAst,
  type ValidationResult,
} from "@/api/lib/legal-search/parsers/validate-ast";
import { guardParser } from "@/api/tests/helpers/parser-reader-guard";

const parseSkDecisionPdf = guardParser(uncheckedParseSkDecisionPdf);

const CASE_NUMBER = "8C/12/2025";
const COURT = "Okresný súd Bratislava I";
const ECLI = "ECLI:SK:OSBA1:2025:1234567890.1";

/** A two-page decision laid out as the court's PDFs are, header on each page. */
const PAGES: readonly (readonly { text: string; bold?: boolean }[])[] = [
  [
    { text: `Súd: ${COURT}` },
    { text: `Spisová znacka: ${CASE_NUMBER}` },
    { text: `ECLI: ${ECLI}` },
    { text: "Rozsudok", bold: true },
    { text: "Okresný súd Bratislava I v konaní o zaplatenie sumy takto" },
    { text: "r o z h o d o l :", bold: true },
    { text: "I. Súd žalobe vyhovuje a žalovanému ukladá zaplatit istinu." },
    { text: "II. Žalobcovi priznáva náhradu trov konania v plnom rozsahu." },
  ],
  [
    { text: `Súd: ${COURT}` },
    { text: `Spisová znacka: ${CASE_NUMBER}` },
    { text: `ECLI: ${ECLI}` },
    { text: "o d ô v o d n e n i e :", bold: true },
    {
      text: "1. Žalobca sa žalobou domáhal zaplatenia dlžnej sumy z kúpnej zmluvy, ktorú",
    },
    {
      text: "žalovaný napriek výzve neuhradil ani po uplynutí lehoty splatnosti.",
    },
    {
      text: "2. Súd vykonal dokazovanie listinami a dospel k záveru, že nárok je dôvodný.",
    },
    { text: "V Bratislave 3. marca 2025" },
    { text: "Mgr. Jana Nováková" },
  ],
];

const decisionPdf = async (): Promise<Uint8Array> => {
  const pdf = PDF.create();
  for (const lines of PAGES) {
    const page = pdf.addPage({ size: "a4" });
    for (const [index, line] of lines.entries()) {
      page.drawText(line.text, {
        x: 56,
        y: 780 - index * 18,
        size: 10,
        font:
          line.bold === true
            ? StandardFonts.HelveticaBold
            : StandardFonts.Helvetica,
      });
    }
  }
  return await pdf.save();
};

const parsed = async (pdfBytes: Uint8Array) =>
  await parseSkDecisionPdf({
    pdfBytes,
    caseNumber: CASE_NUMBER,
    ecli: ECLI,
    court: COURT,
    decisionDate: undefined,
    decisionType: "rozsudok",
  });

const retention = async (
  pdfBytes: Uint8Array,
  dropLongest = false,
): Promise<ValidationResult> => {
  const { documentAst } = await parsed(pdfBytes);
  const projection = await projectSkCourtsDocument(pdfBytes);
  if (projection.type !== "source") {
    throw new Error(`projection answered ${projection.type}`);
  }
  const longest = documentAst.blocks
    .toSorted((left, right) => right.plainText.length - left.plainText.length)
    .at(0);
  return validateAst(
    projection.source,
    dropLongest
      ? documentAst.blocks.filter((block) => block !== longest)
      : documentAst.blocks,
    projection.options,
  );
};

describe("sk-courts document retention projection", () => {
  test("the parsed decision keeps the text of its PDF", async () => {
    const result = await retention(await decisionPdf());
    expect(
      result.ok,
      `retained ${result.stats.retainedPct.toFixed(1)}%, missing ${result.stats.missingWords.join(", ")}`,
    ).toBe(true);
  });

  test("a document that lost a paragraph reads as lost text", async () => {
    expect((await retention(await decisionPdf(), true)).ok).toBe(false);
  });

  test("bytes no PDF opens from are an unreadable document", async () => {
    expect(
      await projectSkCourtsDocument(new TextEncoder().encode("not a pdf")),
    ).toEqual({
      type: "unreadable",
      reason: RETENTION_PROJECTION_FAILURE.UNREADABLE_DOCUMENT,
    });
  });
});
