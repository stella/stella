/**
 * The register's decisions read from their stored paragraphs. The fixtures
 * are two high-court decisions as the reader produced them, shortened, with
 * personal data replaced and the companies' names invented.
 */
import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  CZ_ISIR_PARSE_FAILURE,
  type CzIsirParagraph,
  parseCzIsirDecision as parseUnguarded,
} from "@stll/case-law-parsers/cz-isir";
import { guardParser } from "@stll/case-law-parsers/parser-reader-guard";

const parseCzIsirDecision = guardParser(parseUnguarded);

const paragraphsSchema = v.array(
  v.strictObject({ text: v.string(), bold: v.boolean() }),
);

const fixture = async (name: string): Promise<CzIsirParagraph[]> =>
  v.parse(
    paragraphsSchema,
    await Bun.file(
      new URL(`__fixtures__/${name}.json`, import.meta.url),
    ).json(),
  );

const CONTEXT = {
  documentId: "65350048",
  sourceUrl:
    "https://isir.justice.cz:8443/isir_public_ws/doc/Document?idDokument=65350048",
};

const parsed = async (name: string) => {
  const result = parseCzIsirDecision(await fixture(name), CONTEXT);
  if (Result.isError(result)) {
    throw result.error;
  }
  return result.value;
};

describe("parseCzIsirDecision", () => {
  test("reads an appeal decision in an insolvency file", async () => {
    expect((await parsed("cz-isir-3-vsph-1361-2023")).identity).toEqual({
      instance: "appellate",
      caseNumber: "3 VSPH 1361/2023",
      sheetNumber: undefined,
      filePosition: "B-24",
      court: "Vrchní soud v Praze",
      decisionType: "usnesení",
      decisionDate: "2024-02-22",
      insolvencyFile: "MSPH 60 INS 10782/2023",
    });
  });

  test("reads a judgment in an incidental dispute, with its sheet", async () => {
    expect((await parsed("cz-isir-103-vsph-257-2026")).identity).toEqual({
      instance: "appellate",
      caseNumber: "103 VSPH 257/2026",
      sheetNumber: "103",
      filePosition: undefined,
      court: "Vrchní soud v Praze",
      decisionType: "rozsudek",
      decisionDate: "2026-09-29",
      insolvencyFile: "KSUL 74 INS 12709/2022",
    });
  });

  test("short paragraphs set in bold are the decision's headings", async () => {
    const { documentAst, sections } = await parsed("cz-isir-3-vsph-1361-2023");
    const headings = documentAst.blocks
      .filter((block) => block.type === "heading")
      .map((block) => block.plainText);
    expect(headings).toContain("USNESENÍ");
    expect(headings).toContain("Odůvodnění:");
    expect(headings).toContain("Poučení:");
    expect(sections).toBeDefined();
  });

  test("keeps every paragraph, in order", async () => {
    const paragraphs = await fixture("cz-isir-103-vsph-257-2026");
    const { fulltext } = await parsed("cz-isir-103-vsph-257-2026");
    let from = 0;
    for (const { text } of paragraphs) {
      const at = fulltext.indexOf(text.trim(), from);
      expect(at).toBeGreaterThanOrEqual(from);
      from = at;
    }
  });

  test("a text without its date, heading or docket is no decision", async () => {
    const paragraphs = await fixture("cz-isir-3-vsph-1361-2023");
    const failure = (input: CzIsirParagraph[]) => {
      const result = parseCzIsirDecision(input, CONTEXT);
      return Result.isError(result) ? result.error.reason : null;
    };
    expect(
      failure(
        paragraphs.filter(({ text }) => !text.startsWith("Praha 22. února")),
      ),
    ).toBe(CZ_ISIR_PARSE_FAILURE.NO_DECISION_DATE);
    expect(failure(paragraphs.filter(({ text }) => text !== "USNESENÍ"))).toBe(
      CZ_ISIR_PARSE_FAILURE.NO_DECISION_TYPE,
    );
    expect(failure(paragraphs.slice(1))).toBe(CZ_ISIR_PARSE_FAILURE.NO_DOCKET);
    expect(failure([])).toBe(CZ_ISIR_PARSE_FAILURE.EMPTY);
  });

  test("reads the date a decision was given, in either spelling", () => {
    const decision = (closing: string) =>
      parseCzIsirDecision(
        [
          {
            text: "č. j. KSOS 40 INS 1551/2008 2 VSOL 7/2024-B-206",
            bold: true,
          },
          { text: "USNESENÍ", bold: true },
          { text: "Vrchní soud v Olomouci rozhodl takto.", bold: false },
          { text: closing, bold: false },
        ],
        CONTEXT,
      );
    for (const [closing, date] of [
      ["V Olomouci dne 28. 2. 2024", "2024-02-28"],
      ["Olomouc 28. února 2024", "2024-02-28"],
      ["V Olomouci dne 28. února 2024", "2024-02-28"],
    ] as const) {
      const result = decision(closing);
      expect(Result.isOk(result) && result.value.identity.decisionDate).toBe(
        date,
      );
      expect(Result.isOk(result) && result.value.identity.court).toBe(
        "Vrchní soud v Olomouci",
      );
    }
    expect(Result.isError(decision("V Olomouci dne 30. 2. 2024"))).toBe(true);
  });

  test("dates the decision by its closing, not by a certified copy after it", () => {
    const result = parseCzIsirDecision(
      [
        {
          text: "č. j. MSPH 60 INS 10782/2023 3 VSPH 1361/2023-B-24",
          bold: true,
        },
        { text: "USNESENÍ", bold: true },
        { text: "Vrchní soud v Praze rozhodl takto.", bold: false },
        { text: "Praha 22. února 2024", bold: false },
        { text: "Za správnost vyhotovení: [PERSON_1]", bold: false },
        { text: "Praha 1. března 2024", bold: false },
      ],
      CONTEXT,
    );
    expect(Result.isOk(result) && result.value.identity.decisionDate).toBe(
      "2024-02-22",
    );
  });

  test("reads a regional court's branch under the court it belongs to", () => {
    const result = parseCzIsirDecision(
      [
        { text: "č. j. KSLB 87 INS 984/2026-A-13", bold: true },
        { text: "USNESENÍ", bold: true },
        { text: "Krajský soud v Ústí nad Labem rozhodl takto.", bold: false },
        { text: "Liberec 26. března 2026", bold: false },
      ],
      CONTEXT,
    );
    expect(Result.isOk(result) && result.value.identity).toMatchObject({
      court: "Krajský soud v Ústí nad Labem – pobočka v Liberci",
      insolvencyFile: "KSLB 87 INS 984/2026",
      decisionDate: "2026-03-26",
    });
  });
});
