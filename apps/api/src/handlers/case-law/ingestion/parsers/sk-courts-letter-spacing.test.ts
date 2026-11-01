import { describe, expect, test } from "bun:test";

import { parseSkDecisionPdf } from "@/api/lib/legal-search/parsers/sk-courts";

const FIXTURES = new URL("__fixtures__/", import.meta.url);

/** The decision's paragraphs and headings, role and text, in reading order. */
const readDecision = async (file: string, caseNumber: string) => {
  const parsed = await parseSkDecisionPdf({
    pdfBytes: new Uint8Array(
      await Bun.file(new URL(file, FIXTURES)).arrayBuffer(),
    ),
    caseNumber,
    ecli: undefined,
    court: "Okresný súd",
    decisionDate: undefined,
    decisionType: undefined,
  });
  return parsed.documentAst.blocks.flatMap((block) =>
    block.type === "paragraph" || block.type === "heading"
      ? [{ role: block.role, text: block.plainText }]
      : [],
  );
};

/** Three or more single letters in a row, each followed by a space. */
const SPACED_LETTERS = /(?:^|\s)(?:\p{L}\p{M}* ){3,}/u;

describe("words the court sets letter-spaced read as words", () => {
  // The penal order sets its holding markers two spaces apart between words:
  // `t ý m  s p á c h a l :`.
  test("0T/107/2015: the holding markers keep their word gaps", async () => {
    const blocks = await readDecision(
      "sk-courts-0t-107-2015.pdf",
      "0T/107/2015",
    );
    const texts = blocks.map(({ text }) => text);
    expect(texts).toContain("rozhodol:");
    expect(texts).toContain("je vinný, že:");
    expect(texts).toContain("teda:");
    expect(texts).toContain("tým spáchal:");
    expect(texts).toContain("za to sa odsudzuje:");
    expect(texts.join("\n")).toContain("podmienečne odkladá na skúšobnú dobu");
    expect(texts.filter((text) => SPACED_LETTERS.test(text))).toEqual([]);
  });

  // The appeal decision sets three spaces between letter-spaced words:
  // `odvolanie   n i e   j e   p r í p u s t n é.`
  test("6CoP/34/2011: the verb, the headings and the instruction read whole", async () => {
    const blocks = await readDecision(
      "sk-courts-6cop-34-2011.pdf",
      "6CoP/34/2011",
    );
    expect(blocks).toContainEqual({
      role: "section-heading",
      text: "rozhodol:",
    });
    expect(blocks).toContainEqual({
      role: "holding",
      text: "Odvolanie Y. W. odmieta.",
    });
    expect(blocks).toContainEqual({
      role: "section-heading",
      text: "odôvodnenie:",
    });
    const texts = blocks.map(({ text }) => text);
    expect(texts).toContain(
      "Proti tomuto uzneseniu odvolanie nie je prípustné.",
    );
    expect(texts.filter((text) => SPACED_LETTERS.test(text))).toEqual([]);
  });
});
