import { describe, expect, test } from "bun:test";

import type { VerificationBlock } from "@/api/lib/lists/verification/document-text";
import {
  claimParagraphNumbers,
  passageContext,
  resolveParagraphScope,
  scopedBlockContext,
  scopePassages,
} from "@/api/lib/lists/verification/paragraph-scope";

const docx = (
  id: string,
  text: string,
  structure: { label?: string; heading?: boolean } = {},
): VerificationBlock => ({
  id,
  text,
  source: { type: "docx-block", blockId: id },
  structure: {
    type: "docx-paragraph",
    label: structure.label ?? null,
    heading: structure.heading ?? false,
  },
});

describe("resolveParagraphScope", () => {
  test("reads Word's own paragraph numbers, which are not in the text", () => {
    const blocks = [
      docx("t", "Witness statement of a sample witness", { heading: true }),
      docx("a", "I am a director of the company.", { label: "1." }),
      docx("b", "I met the buyer in March.", { label: "2." }),
      docx("h", "The payment", { heading: true }),
      docx("c", "The payment was made on 10 August.", { label: "3." }),
      docx("d", "I did not approve it.", { label: "4." }),
    ];
    const resolution = resolveParagraphScope(blocks, { from: 2, to: 2 });
    expect(resolution).toEqual({
      type: "resolved",
      scope: {
        kind: "paragraphs",
        from: 2,
        to: 2,
        numbering: "document",
        start: { blockId: "b", offset: 0 },
        // The next section starts at its heading.
        end: { blockId: "h", offset: 0 },
      },
    });
  });

  test("the last numbered paragraph stops at an annex that follows it", () => {
    const blocks = [
      docx("a", "I am a director of the company.", { label: "1." }),
      docx("b", "I met the buyer in March.", { label: "2." }),
      docx("c", "The payment was made on 10 August.", { label: "3." }),
      docx("d", "I did not approve it.", { label: "4." }),
      docx("e", "It was made without my knowledge."),
      docx("h", "Annex A", { heading: true }),
      docx("x", "The bank statement shows a transfer on 11 August."),
    ];
    const resolution = resolveParagraphScope(blocks, { from: 4, to: 4 });
    expect(resolution.type === "resolved" && resolution.scope).toMatchObject({
      start: { blockId: "d", offset: 0 },
      // Paragraph 4 keeps its unnumbered text; the annex is outside it.
      end: { blockId: "h", offset: 0 },
    });
  });

  test("counts paragraphs in order when the document numbers none", () => {
    const blocks = [
      docx("t", "Letter of instruction", { heading: true }),
      docx("a", "We act for the claimant."),
      docx("b", "The contract was signed in May."),
      docx("c", "Payment fell due in June."),
    ];
    const resolution = resolveParagraphScope(blocks, { from: 2, to: 3 });
    expect(resolution.type === "resolved" && resolution.scope).toMatchObject({
      numbering: "ordinal",
      start: { blockId: "b", offset: 0 },
      end: { blockId: "c", offset: "Payment fell due in June.".length },
    });
  });

  test("refuses a document whose printed numbers do not read as a numbering", () => {
    // Numbering starting midway (an unreadable first page) is not counted
    // by position: that would silently name other paragraphs.
    const blocks = [
      docx("a", "9. My roles before the pandemic were these:"),
      docx("b", "a) In 2016 I became a parliamentary secretary;"),
      docx("c", "b) In 2018 I became a vice chair."),
      docx("d", "10. From February 2020 I served as a minister:"),
      docx("e", "a) for adult social care."),
      docx("f", "11. I left that role in September 2021."),
    ];
    expect(resolveParagraphScope(blocks, { from: 10, to: 11 })).toEqual({
      type: "numbering-unclear",
    });
  });

  test("names both ends when neither is printed", () => {
    const blocks = [
      docx("a", "1. I am a director."),
      docx("b", "2. I met the buyer."),
      docx("c", "3. I did not approve it."),
    ];
    expect(resolveParagraphScope(blocks, { from: 7, to: 9 })).toEqual({
      type: "not-found",
      numbering: "document",
      missing: [7, 9],
      available: { from: 1, to: 3 },
    });
  });

  test("refuses a range closed by a number printed only before it", () => {
    const blocks = [
      docx("a", "1. I am a director."),
      docx("b", "2. I met the buyer."),
      docx("c", "3. I did not approve it."),
    ];
    expect(resolveParagraphScope(blocks, { from: 3, to: 3 }).type).toBe(
      "resolved",
    );
    expect(resolveParagraphScope(blocks, { from: 3, to: 5 })).toMatchObject({
      type: "not-found",
      missing: [5],
    });
  });
});

describe("passageContext", () => {
  test("the grader reads the claim's passage, never the rest of its page", () => {
    const page =
      "81. Outside, before.\n82. I agreed the plan on 2 April.\n83. Outside, after.";
    const block: VerificationBlock = {
      id: "P4",
      text: page,
      source: { type: "pdf-page", pageNumber: 4 },
    };
    const start = page.indexOf("82.");
    const end = page.indexOf("83.");
    const claimStart = page.indexOf("I agreed");
    const claimEnd = claimStart + "I agreed the plan on 2 April".length;
    const context = passageContext(
      { block, start, end },
      { start: claimStart, end: claimEnd },
    );
    expect(context.text).toBe("82. I agreed the plan on 2 April.\n");
    expect(context.text).not.toContain("Outside");
    expect(context.text.slice(context.anchor.start, context.anchor.end)).toBe(
      "I agreed the plan on 2 April",
    );
  });
});

describe("scopedBlockContext", () => {
  const page =
    "81. Outside, before.\n82. I agreed the plan on 2 April.\n83. Outside, after.";
  const claimStart = page.indexOf("I agreed");
  const claim = {
    start: claimStart,
    end: claimStart + "I agreed the plan on 2 April".length,
  };
  const scope = {
    kind: "paragraphs" as const,
    from: 82,
    to: 82,
    numbering: "document" as const,
    start: { blockId: "P4", offset: page.indexOf("82.") },
    end: { blockId: "P4", offset: page.indexOf("83.") },
  };

  test("a re-check reads the stored page as the run's grading read it", () => {
    const block: VerificationBlock = {
      id: "P4",
      text: page,
      source: { type: "pdf-page", pageNumber: 4 },
    };
    expect(scopedBlockContext({ id: "P4", text: page }, scope, claim)).toEqual(
      passageContext(
        { block, start: scope.start.offset, end: scope.end.offset },
        claim,
      ),
    );
  });

  test("a block the range does not cut, or a whole-document run, reads whole", () => {
    expect(
      scopedBlockContext({ id: "P5", text: page }, scope, claim).text,
    ).toBe(page);
    expect(
      scopedBlockContext({ id: "P4", text: page }, { kind: "whole" }, claim),
    ).toEqual({ text: page, anchor: claim });
  });
});

describe("scopePassages", () => {
  const blocks = [
    docx("a", "1. I am a director."),
    docx("b", "2. I met the buyer."),
    docx("c", "3. I did not approve it."),
  ];

  test("a whole-document run reads every block whole", () => {
    expect(scopePassages(blocks, { kind: "whole" })).toEqual(
      blocks.map((block) => ({ block, start: 0, end: block.text.length })),
    );
  });

  test("a range that no longer lands in the blocks read reads nothing", () => {
    expect(
      scopePassages(blocks, {
        kind: "paragraphs",
        from: 2,
        to: 2,
        numbering: "document",
        start: { blockId: "gone", offset: 0 },
        end: { blockId: "c", offset: 0 },
      }),
    ).toBeNull();
    expect(
      scopePassages(blocks, {
        kind: "paragraphs",
        from: 2,
        to: 2,
        numbering: "document",
        start: { blockId: "b", offset: 0 },
        end: { blockId: "c", offset: 999 },
      }),
    ).toBeNull();
  });
});

describe("claimParagraphNumbers", () => {
  const at = (blockId: string, start = 0) =>
    ({ type: "docx-block", blockId, start, end: start + 1 }) as const;

  test("numbers a claim by the printed paragraph it sits in, as a range of that number reads it", () => {
    const blocks = [
      docx("t", "Witness statement of a sample witness", { heading: true }),
      docx("a", "I am a director of the company.", { label: "1." }),
      docx("b", "I met the buyer in March.", { label: "2." }),
      docx("b2", "He asked for the July drawdown."),
      docx("h", "The payment", { heading: true }),
      docx("c", "The payment was made on 10 August.", { label: "3." }),
      docx("d", "I did not approve it.", { label: "4." }),
      docx("x", "Annex A", { heading: true }),
      docx("y", "The bank statement shows a transfer on 11 August."),
    ];
    const paragraphOf = claimParagraphNumbers(blocks);
    expect(paragraphOf(at("a", 5))).toBe(1);
    expect(paragraphOf(at("b"))).toBe(2);
    // Unnumbered text after a paragraph is that paragraph's.
    expect(paragraphOf(at("b2", 4))).toBe(2);
    expect(paragraphOf(at("c", 12))).toBe(3);
    expect(paragraphOf(at("d"))).toBe(4);
    // A title before the numbering, the heading that opens a section and an
    // annex the numbering does not reach belong to no paragraph.
    expect(paragraphOf(at("t"))).toBeNull();
    expect(paragraphOf(at("h"))).toBeNull();
    expect(paragraphOf(at("x"))).toBeNull();
    expect(paragraphOf(at("y"))).toBeNull();
    // A block the run did not read names no paragraph.
    expect(paragraphOf(at("gone"))).toBeNull();
    // The number agrees with the text a range of that number reads.
    const range = resolveParagraphScope(blocks, { from: 2, to: 2 });
    expect(range.type === "resolved" && range.scope).toMatchObject({
      start: { blockId: "b", offset: 0 },
      end: { blockId: "h", offset: 0 },
    });
  });

  test("counts by position when the document numbers no paragraphs", () => {
    const blocks = [
      docx("t", "Letter of instruction", { heading: true }),
      docx("a", "We act for the claimant."),
      docx("b", "The contract was signed in May."),
      docx("c", "Payment fell due in June."),
    ];
    const paragraphOf = claimParagraphNumbers(blocks);
    expect(paragraphOf(at("a"))).toBe(1);
    expect(paragraphOf(at("c", 8))).toBe(3);
    expect(paragraphOf(at("t"))).toBeNull();
  });

  test("names no number when the document's numbering is unclear", () => {
    const blocks = [
      docx("a", "9. My roles before the pandemic were these:"),
      docx("b", "a) In 2016 I became a parliamentary secretary;"),
      docx("c", "b) In 2018 I became a vice chair."),
      docx("d", "10. From February 2020 I served as a minister:"),
      docx("e", "a) for adult social care."),
      docx("f", "11. I left that role in September 2021."),
    ];
    const paragraphOf = claimParagraphNumbers(blocks);
    for (const block of blocks) {
      expect(paragraphOf(at(block.id, 3))).toBeNull();
    }
  });

  test("reads a page's lines back into paragraphs and finds a claim's offset in them", () => {
    const page = [
      "1. I am a director of the company and I make this statement from",
      "my own knowledge.",
      "",
      "2. I met the buyer in March 2021 at the offices of the company in",
      "the presence of the finance director.",
      "",
      "3. I did not approve the payment.",
    ].join("\n");
    const blocks: VerificationBlock[] = [
      {
        id: "P1",
        text: page,
        source: { type: "pdf-page", pageNumber: 1 },
        structure: { type: "pdf-lines", boxes: null },
      },
    ];
    const paragraphOf = claimParagraphNumbers(blocks);
    const claimAt = (words: string, pageNumber = 1) => {
      const start = page.indexOf(words);
      return {
        type: "pdf-page",
        pageNumber,
        start,
        end: start + words.length,
      } as const;
    };
    expect(paragraphOf(claimAt("my own knowledge"))).toBe(1);
    expect(paragraphOf(claimAt("the finance director"))).toBe(2);
    expect(paragraphOf(claimAt("approve the payment"))).toBe(3);
    // A page the run did not read names no paragraph.
    expect(paragraphOf(claimAt("my own knowledge", 2))).toBeNull();
  });
});
