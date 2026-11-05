/**
 * The sentence that introduces a CJEU ruling (`On those grounds, THE COURT
 * hereby rules:`) is not part of the ruling. Where the Court sets it on
 * several lines, those lines carry no role; where it is one line it is the
 * operative part's heading, and everything after it is the ruling.
 */
import { describe, expect, test } from "bun:test";

import type { Block, ParagraphRole } from "@stll/legal-ast/document-ast";

import { guardParser } from "@/api/tests/helpers/parser-reader-guard";

import { parseEcjDecisionHtml as uncheckedParseEcjDecisionHtml } from "./eu-ecj";

const parseEcjDecisionHtml = guardParser(uncheckedParseEcjDecisionHtml);

const FIXTURES_DIR = new URL("__fixtures__/eu-ecj/", import.meta.url);

const decoder = new TextDecoder();

const parseFixture = async (stem: string): Promise<readonly Block[]> => {
  const bytes = await Bun.file(
    new URL(`${stem}.html.gz`, FIXTURES_DIR),
  ).bytes();
  const [celex = stem] = stem.split(".");
  return parseEcjDecisionHtml({
    caseNumber: celex,
    ecli: undefined,
    court: "CJEU",
    decisionDate: undefined,
    decisionType: undefined,
    sourceUrl: undefined,
    celex,
    html: decoder.decode(Bun.gunzipSync(bytes)),
  }).documentAst.blocks;
};

type Expected = readonly (readonly [string, ParagraphRole | undefined])[];

/** The role of the last paragraph that starts with each prefix: the header
 * prints the bench too. */
const rolesOf = (blocks: readonly Block[], expected: Expected): Expected =>
  expected.map(([prefix]) => {
    const block = blocks.findLast(
      (candidate) =>
        candidate.type === "paragraph" &&
        candidate.plainText.startsWith(prefix),
    );
    if (block?.type !== "paragraph") {
      throw new Error(`no paragraph starts with ${prefix}`);
    }
    return [prefix, block.role] as const;
  });

const CASES = [
  {
    name: "General Court: the formula in the unmarked opening row",
    stem: "62023TJ0201.en",
    expected: [
      ["THE GENERAL COURT (Sixth Chamber)", undefined],
      ["hereby:", undefined],
      ["1. Dismisses the action;", "holding"],
      ["2. Orders the Communications Regulatory Authority", "holding"],
    ],
  },
  {
    name: "oldest layout: bare lines under the operative part's anchor",
    stem: "61990CJ0006.en",
    expected: [
      ["On those grounds,", undefined],
      ["THE COURT,", undefined],
      ["in answer to the questions submitted to it", undefined],
      ["1. The provisions of Council Directive 80/987/EEC", "holding"],
      ["2. A Member State is required to make good loss", "holding"],
    ],
  },
  {
    name: "oldest layout in Czech: the formula ends at its colon",
    stem: "62013TO0488.cs",
    expected: [
      ["Z těchto důvodů", undefined],
      ["TRIBUNÁL (druhý senát)", undefined],
      ["rozhodl takto:", undefined],
      ["1) Žaloba se odmítá.", "holding"],
    ],
  },
  {
    name: "Hungarian: the formula as one bare line",
    stem: "62004CJ0144.hu",
    expected: [["A fenti indokok alapján, a Bíróság (nagytanács)", undefined]],
  },
  {
    name: "Greek: a heading that ends in a colon holds the whole formula",
    stem: "62022CJ0128.el",
    expected: [
      ["1) Τα άρθρα 27 και 29 της οδηγίας 2004/38/ΕΚ", "holding"],
      ["έχουν την έννοια ότι:", "holding"],
      ["δεν αντιτίθενται σε γενικής ισχύος ρύθμιση", "holding"],
    ],
  },
] as const satisfies readonly {
  name: string;
  stem: string;
  expected: Expected;
}[];

describe("CJEU operative-part formula", () => {
  for (const { name, stem, expected } of CASES) {
    test(name, async () => {
      expect<Expected>(rolesOf(await parseFixture(stem), expected)).toEqual(
        expected,
      );
    });
  }
});
