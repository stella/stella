/**
 * The title of a Slovak court decision and the formula it decides under,
 * which the court sets in one type, read apart: the formula is the court's
 * opening words, not its title.
 */

import { describe, expect, test } from "bun:test";

import { parseSkDecisionPdf as uncheckedParseSkDecisionPdf } from "@/api/lib/legal-search/parsers/sk-courts";
import { guardParser } from "@/api/tests/helpers/parser-reader-guard";

const parseSkDecisionPdf = guardParser(uncheckedParseSkDecisionPdf);

const FIXTURES = new URL("__fixtures__/", import.meta.url);

const headMatter = async (file: string, caseNumber: string) => {
  const parsed = await parseSkDecisionPdf({
    pdfBytes: await Bun.file(new URL(file, FIXTURES)).bytes(),
    caseNumber,
    ecli: undefined,
    court: "Okresný súd",
    decisionDate: undefined,
    decisionType: undefined,
  });
  const blocks = parsed.documentAst.blocks;
  const title = blocks.findIndex(
    (block) => block.type === "heading" && block.role === "decision-title",
  );
  return blocks.slice(title, title + 2).map((block) => ({
    type: block.type,
    role: "role" in block ? block.role : undefined,
    text: block.plainText,
  }));
};

describe("a Slovak decision's title and formula", () => {
  test.each([
    // The formula runs on from the title line: `ROZSUDOK V MENE` /
    // `SLOVENSKEJ REPUBLIKY`.
    ["sk-courts-19c-150-2006.pdf", "19C/150/2006", "ROZSUDOK"],
    ["sk-courts-0t-107-2015.pdf", "0T/107/2015", "TRESTNÝ ROZKAZ"],
    ["sk-courts-2t-103-2020.pdf", "2T/103/2020", "ROZSUDOK"],
  ])(
    "%s: the title, then the formula as opening words",
    async (file, caseNumber, title) => {
      expect(await headMatter(file, caseNumber)).toEqual([
        { type: "heading", role: "decision-title", text: title },
        {
          type: "paragraph",
          role: "opening-formula",
          text: "V MENE SLOVENSKEJ REPUBLIKY",
        },
      ]);
    },
  );

  test("a resolution with no formula keeps its title alone", async () => {
    const [title, next] = await headMatter(
      "sk-courts-6cop-34-2011.pdf",
      "6CoP/34/2011",
    );
    expect(title).toEqual({
      type: "heading",
      role: "decision-title",
      text: "Uznesenie",
    });
    expect(next?.text).toStartWith("Krajský súd v Trenčíne");
  });
});

describe("the portal's metadata box", () => {
  // The portal prints the record's metadata above every decision. It is
  // kept as printed, as front matter in every row, never as the body.
  test.each([
    ["sk-courts-2t-103-2020.pdf", "2T/103/2020"],
    ["sk-courts-19c-150-2006.pdf", "19C/150/2006"],
  ])("%s: every row is front matter", async (file, caseNumber) => {
    const parsed = await parseSkDecisionPdf({
      pdfBytes: await Bun.file(new URL(file, FIXTURES)).bytes(),
      caseNumber,
      ecli: undefined,
      court: "Okresný súd",
      decisionDate: undefined,
      decisionType: undefined,
    });
    const blocks = parsed.documentAst.blocks;
    const title = blocks.findIndex(
      (block) => block.type === "heading" && block.role === "decision-title",
    );
    const box = blocks.slice(0, title);

    expect(box.map((block) => block.plainText.split(":")[0])).toEqual([
      "Súd",
      "Spisová značka",
      "Identifikačné číslo súdneho spisu",
      "Dátum vydania rozhodnutia",
      "Meno a priezvisko sudcu, VSÚ",
      "ECLI",
    ]);
    expect(
      box.map((block) => ("role" in block ? block.role : undefined)),
    ).toEqual(box.map(() => "front-matter"));
  });
});
