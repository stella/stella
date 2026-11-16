/**
 * Roles of recorded ÚOHS decisions, read by the decision's own parts: the
 * head matter up to the lead-in introduces the ruling, the operative part
 * after it holds it, the reasons start at their heading, the barcode is the
 * filing system's, the head of the Office signs under its office, and the
 * title, the reasons, their Roman sections and the instruction are headings.
 */

import { describe, expect, test } from "bun:test";

import type { Block, ParagraphBlock } from "@stll/legal-ast/document-ast";

import { parseCzUohsDocumentPdf as uncheckedParseCzUohsDocumentPdf } from "@/api/handlers/case-law/ingestion/adapters/cz-uohs";
import { structureFidelityIn } from "@/api/lib/legal-search/parsers/structure-fidelity";
import { guardParser } from "@/api/tests/helpers/parser-reader-guard";

const parseCzUohsDocumentPdf = guardParser(uncheckedParseCzUohsDocumentPdf);

const FIXTURES = new URL("__fixtures__/", import.meta.url);

const blocksOf = async (name: string): Promise<Block[]> =>
  (
    await parseCzUohsDocumentPdf(
      await Bun.file(new URL(name, FIXTURES)).bytes(),
      { caseNumber: name, sourceUrl: `https://uohs.gov.cz/${name}` },
    )
  ).blocks;

const body = (blocks: readonly Block[]): ParagraphBlock[] =>
  blocks.filter(
    (block): block is ParagraphBlock =>
      block.type === "paragraph" && block.note === undefined,
  );

const withRole = (
  blocks: readonly Block[],
  role: ParagraphBlock["role"],
): string[] =>
  body(blocks)
    .filter((block) => block.role === role)
    .map((block) => block.plainText);

const headings = (blocks: readonly Block[]): string[] =>
  blocks.flatMap((block) =>
    block.type === "heading"
      ? [`${block.level} ${block.role ?? "-"} ${block.plainText}`]
      : [],
  );

const roleFindings = (blocks: readonly Block[]): string[] =>
  structureFidelityIn(blocks, "cs")
    .filter(({ rule }) =>
      [
        "signature-as-holding",
        "holding-after-reasons",
        "holding-after-signature",
      ].includes(rule),
    )
    .map(({ rule, anchorId }) => `${rule} ${anchorId}`);

describe("ÚOHS decisions read by their parts", () => {
  test("R0003/2018: the head matter introduces the ruling the President states after rozhodl takto:", async () => {
    const blocks = await blocksOf("cz-uohs-2018-R0003.pdf");

    expect(withRole(blocks, "apparatus")).toEqual(["UOHSX00BKPME"]);
    expect(withRole(blocks, "intro")).toEqual([
      "PŘEDSEDA ÚŘADU PRO OCHRANU HOSPODÁŘSKÉ SOUTĚŽE",
      "Č. j.: ÚOHS-R0003/2018/HS-31751/310/MHf Brno 1. listopadu 2018",
      expect.stringMatching(/^V řízení o rozkladu/u),
      "rozhodl takto:",
    ]);
    expect(withRole(blocks, "holding")).toEqual([
      expect.stringContaining("potvrzuji a podaný rozklad zamítám."),
    ]);
    expect(withRole(blocks, "signature")).toEqual([
      "Ing. Petr Rafaj předseda Úřadu pro ochranu hospodářské soutěže",
    ]);
    expect(headings(blocks)).toEqual([
      "1 decision-title ROZHODNUTÍ",
      "2 section-heading ODŮVODNĚNÍ",
      "3 - I. NAPADENÉ ROZHODNUTÍ",
      "3 - II. ROZKLAD",
      "3 - III. ŘÍZENÍ O ROZKLADU",
      "3 - IV. PŘEZKUM NAPADENÉHO ROZHODNUTÍ",
      "3 - V. ZÁVĚR",
      "2 section-heading POUČENÍ",
    ]);
    expect(roleFindings(blocks)).toEqual([]);
  });

  test("S0569/2015: the ruling after ROZHODNUTÍ: holds its four points, and the Vice-Chairman signs", async () => {
    const blocks = await blocksOf("cz-uohs-2015-S0569.pdf");
    const holdings = withRole(blocks, "holding");

    expect(withRole(blocks, "intro").at(-1)).toBe("ROZHODNUTÍ:");
    expect(holdings.filter((text) => /^[IV]+\.$/u.test(text))).toEqual([
      "I.",
      "II.",
      "III.",
      "IV.",
    ]);
    expect(holdings.at(-1)).toBe(
      "Náklady řízení jsou splatné do 15 dnů ode dne právní moci tohoto rozhodnutí.",
    );
    expect(holdings).not.toContain("ODŮVODNĚNÍ");
    expect(withRole(blocks, "signature")).toEqual([
      "JUDr. Hynek Brom",
      "I. místopředseda Úřadu",
    ]);
    // The signature after the instruction is no section of the reasons.
    expect(headings(blocks).at(-1)).toBe("2 section-heading POUČENÍ");
    expect(roleFindings(blocks)).toEqual([]);
  });
});
