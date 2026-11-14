/**
 * Slovak courts' printed paragraph labels, read from recorded decisions
 * through the one label grammar: a sub-paragraph (`1.2.`, `5.5.`) opens its
 * own paragraph, a date wrapped after its day (`dňa` / `2. júla 2014`) does
 * not, and the court's `2.`, `3.` become the paragraph's number.
 */

import { describe, expect, test } from "bun:test";

import { type Block, plainTextOf } from "@stll/legal-ast/document-ast";

import { parseSkDecisionPdf as uncheckedParseSkDecisionPdf } from "@/api/lib/legal-search/parsers/sk-courts";
import { guardParser } from "@/api/tests/helpers/parser-reader-guard";

const parseSkDecisionPdf = guardParser(uncheckedParseSkDecisionPdf);

const FIXTURES = new URL("__fixtures__/", import.meta.url);

type Read = { number: number | undefined; text: string };

const paragraphs = (blocks: readonly Block[]): Read[] =>
  blocks.flatMap((block) =>
    block.type === "paragraph"
      ? [
          {
            number: block.number,
            text: plainTextOf(block.inlines).replaceAll(/\s+/gu, " ").trim(),
          },
        ]
      : [],
  );

type Decision = {
  readonly file: string;
  readonly court: string;
  readonly caseNumber: string;
  readonly ecli: string | undefined;
};

const read = async ({ file, court, caseNumber, ecli }: Decision) => {
  const parsed = await parseSkDecisionPdf({
    pdfBytes: new Uint8Array(
      await Bun.file(new URL(file, FIXTURES)).arrayBuffer(),
    ),
    caseNumber,
    ecli,
    court,
    decisionDate: undefined,
    decisionType: undefined,
  });
  return paragraphs(parsed.documentAst.blocks);
};

const startingWith = (blocks: readonly Read[], prefix: string): Read[] =>
  blocks.filter(({ text }) => text.startsWith(prefix));

describe("Krajský súd Bratislava 15CoPr/4/2020", () => {
  const decision = {
    file: "sk-courts-15copr-4-2020.pdf",
    court: "Krajský súd Bratislava",
    caseNumber: "15CoPr/4/2020",
    ecli: "ECLI:SK:KSBA:2021:1214225585.1",
  };

  test("sub-paragraphs 1.1, 1.2 and 1.3 are paragraphs of their own", async () => {
    const blocks = await read(decision);
    for (const label of ["1.1. ", "1.2. ", "1.3. "]) {
      expect(startingWith(blocks, label)).toHaveLength(1);
    }
    const [first] = startingWith(blocks, "1.1. ");
    expect(first?.text).toEndWith("pre ňu vhodnú prácu.");
    expect(blocks.some(({ text }) => text.includes(" 1.2. Súd"))).toBe(false);
  });

  test("the court's paragraph numbers 2 to 21 are structure, not text", async () => {
    const blocks = await read(decision);
    expect(blocks.flatMap(({ number }) => number ?? [])).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 2),
    );
    const second = blocks.find(({ number }) => number === 2);
    expect(second?.text).toStartWith("Proti rozsudku súdu prvej inštancie");
  });
});

describe("Najvyšší súd 4Cdo/21/2022", () => {
  const decision = {
    file: "sk-courts-4cdo-21-2022.pdf",
    court: "Najvyšší súd",
    caseNumber: "4Cdo/21/2022",
    ecli: "ECLI:SK:NSSR:2024:7114225191.1",
  };

  test("a date wrapped after its day continues the sentence", async () => {
    const blocks = await read(decision);
    expect(
      blocks.some(({ text }) =>
        text.includes("nadobudol právoplatnosť dňa 2. júla 2014, pričom"),
      ),
    ).toBe(true);
    expect(
      blocks.some(({ text }) =>
        text.includes("v Košiciach z 12. mája 2021 č. k. 9Co/80/2020-234"),
      ),
    ).toBe(true);
    expect(startingWith(blocks, "2. júla")).toEqual([]);
    expect(startingWith(blocks, "12. mája")).toEqual([]);
  });

  test("sub-paragraphs open their own paragraphs, at a page start too", async () => {
    const blocks = await read(decision);
    for (const label of ["5.5. Dovolanie", "6.5. Odvolací", "16.1. Dovolací"]) {
      expect(startingWith(blocks, label)).toHaveLength(1);
    }
    expect(
      blocks.some(({ text }) => /\S \d{1,2}\.\d{1,2}\. \p{Lu}/u.test(text)),
    ).toBe(false);
  });

  test("the court's numbers run 1 to 20", async () => {
    const blocks = await read(decision);
    expect(blocks.flatMap(({ number }) => number ?? [])).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
  });
});

describe("Okresný súd Trenčín 19C/150/2006", () => {
  const decision = {
    file: "sk-courts-19c-150-2006.pdf",
    court: "Okresný súd Trenčín",
    caseNumber: "19C/150/2006",
    ecli: undefined,
  };

  test("a dash item at a page start is an item of its own", async () => {
    const blocks = await read(decision);
    expect(startingWith(blocks, "- rozhodoval vylúčený sudca")).toEqual([
      { number: undefined, text: "- rozhodoval vylúčený sudca," },
    ]);
    expect(
      startingWith(blocks, "- súd prvého stupňa nesprávne právne posúdil vec"),
    ).toHaveLength(1);
  });
});

describe("Okresný súd Martin 2T/103/2020", () => {
  test("a lettered point after `písm.` at a line wrap continues the citation", async () => {
    const blocks = await read({
      file: "sk-courts-2t-103-2020.pdf",
      court: "Okresný súd Martin",
      caseNumber: "2T/103/2020",
      ecli: undefined,
    });
    expect(startingWith(blocks, "e) Tr. zák.")).toEqual([]);
    expect(
      blocks.some(({ text }) =>
        text.includes(
          "s poukazom na § 139 ods. 1 písm. e) Tr. zák. a na § 127 ods. 3 Tr. zák.",
        ),
      ),
    ).toBe(true);
  });
});

describe("Mestský súd Bratislava IV 16C/45/2025", () => {
  const decision = {
    file: "sk-courts-16c-45-2025.pdf",
    court: "Mestský súd Bratislava IV",
    caseNumber: "16C/45/2025",
    ecli: "ECLI:SK:MSBA4:2026:6125388965.3",
  };

  test("sub-paragraphs 6.12 and 6.13 stay apart", async () => {
    const blocks = await read(decision);
    expect(startingWith(blocks, "6.12. ")).toEqual([
      {
        number: undefined,
        text: "6.12. Podľa § 524 ods. 1 O.z. veriteľ môže svoju pohľadávku aj bez súhlasu dlžníka postúpiť písomnou zmluvou inému.",
      },
    ]);
    expect(startingWith(blocks, "6.13. ")).toHaveLength(1);
  });

  test("the court's paragraph numbers are block numbers beside its sub-paragraphs", async () => {
    const blocks = await read(decision);
    const numbers = blocks.flatMap(({ number }) => number ?? []);
    expect(numbers.slice(0, 6)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(blocks.find(({ number }) => number === 5)?.text).toBe(
      "Súd pri rozhodovaní vychádzal z nasledovného skutkového stavu:",
    );
    expect(
      blocks.filter(({ text }) => /^5\.\d{1,2}\. /u.test(text)),
    ).toHaveLength(11);
  });
});
