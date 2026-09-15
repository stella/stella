import { describe, expect, test } from "bun:test";

import type { DocumentAst } from "@stll/legal-ast/document-ast";

import { citationPassageIn } from "@/api/handlers/case-law/decisions/citation-passages";
import { LIMITS } from "@/api/lib/limits";

const astOf = (
  paragraphs: readonly { anchorId: string; text: string }[],
): DocumentAst => ({
  version: 1,
  source: { system: "test", documentId: "d1", webUrl: "", printUrl: "" },
  metadata: {
    caseNumber: "29 Cdo 123/2024",
    court: "Nejvyšší soud",
    ecli: "ECLI:CZ:NS:2024:29.CDO.123.2024.1",
    decisionDate: "2024-02-01",
    decisionType: "rozsudek",
    keywords: [],
    statutes: [],
  },
  blocks: paragraphs.map(({ anchorId, text }, index) => ({
    id: `b${String(index)}`,
    anchorId,
    type: "paragraph",
    inlines: [{ type: "text", text }],
    plainText: text,
  })),
});

describe("the block a citation is read from", () => {
  test("is the block whose text carries the citation, by its anchor", () => {
    const passage = citationPassageIn({
      ast: astOf([
        { anchorId: "p1", text: "Úvod bez citace." },
        {
          anchorId: "p2",
          text: "Soud vyšel z rozsudku 21 Cdo 500/2019 a dovodil, že nárok trvá.",
        },
      ]),
      citationText: "21 Cdo 500/2019",
      sectionText: undefined,
    });

    expect(passage).toEqual({
      anchorId: "p2",
      text: "Soud vyšel z rozsudku 21 Cdo 500/2019 a dovodil, že nárok trvá.",
      truncated: false,
      mention: "sole",
    });
  });

  test("is the last mention, not the bare listing in the header", () => {
    const ast = astOf([
      { anchorId: "p1", text: "21 Cdo 500/2019" },
      {
        anchorId: "p9",
        text: "Od závěrů rozsudku 21 Cdo 500/2019 se senát odchyluje.",
      },
    ]);
    // The fixture reaches the fault: both blocks carry the citation, so a
    // first-match reader would answer with the header.
    expect(
      ast.blocks.filter((block) => block.plainText.includes("21 Cdo 500/2019")),
    ).toHaveLength(2);

    expect(
      citationPassageIn({
        ast,
        citationText: "21 Cdo 500/2019",
        sectionText: undefined,
      })?.anchorId,
    ).toBe("p9");
  });

  test("says the paragraph was a choice when several blocks carry the citation", () => {
    const ast = astOf([
      { anchorId: "p1", text: "21 Cdo 500/2019" },
      {
        anchorId: "p9",
        text: "Od závěrů rozsudku 21 Cdo 500/2019 se senát odchyluje.",
      },
    ]);

    // The treatment beside this passage was classified from whichever mention
    // ingestion recorded, which is not addressable from the AST: a reader that
    // reported `sole` here would pair a treatment with a paragraph that may
    // not be the one it was read from.
    expect(
      citationPassageIn({
        ast,
        citationText: "21 Cdo 500/2019",
        sectionText: undefined,
      })?.mention,
    ).toBe("latest_of_several");
  });

  test("is the sole mention when one block carries the citation twice", () => {
    const ast = astOf([
      {
        anchorId: "p2",
        text: "Rozsudek 21 Cdo 500/2019; na 21 Cdo 500/2019 soud odkázal znovu.",
      },
    ]);
    // Two occurrences, one block: the paragraph is the same either way, so
    // counting occurrences rather than blocks would report a choice that the
    // document does not offer.
    expect(ast.blocks).toHaveLength(1);

    expect(
      citationPassageIn({
        ast,
        citationText: "21 Cdo 500/2019",
        sectionText: undefined,
      })?.mention,
    ).toBe("sole");
  });

  test("is the classified section's own paragraph when the row still has it", () => {
    const ast = astOf([
      { anchorId: "p1", text: "Přehled: 21 Cdo 500/2019." },
      {
        anchorId: "p7",
        text: "K rozsudku 21 Cdo 500/2019 se senát přiklání.",
      },
      {
        anchorId: "p9",
        text: "Od závěrů rozsudku 21 Cdo 500/2019 se senát odchyluje.",
      },
    ]);
    // The recorded section holds the middle paragraph, which is the mention
    // the classifier read; the last paragraph says the opposite, so a reader
    // that ignored the section would pair the treatment with its contrary.
    const sectionText =
      "K rozsudku 21 Cdo 500/2019 se senát přiklání. Další věta sekce.";
    expect(
      citationPassageIn({
        ast,
        citationText: "21 Cdo 500/2019",
        sectionText: undefined,
      })?.anchorId,
    ).toBe("p9");

    const passage = citationPassageIn({
      ast,
      citationText: "21 Cdo 500/2019",
      sectionText,
    });

    expect(passage?.anchorId).toBe("p7");
    expect(passage?.mention).toBe("classified_section");
  });

  test("falls back to the last mention when the section is not in the document", () => {
    const ast = astOf([
      { anchorId: "p1", text: "Přehled: 21 Cdo 500/2019." },
      {
        anchorId: "p9",
        text: "Od závěrů rozsudku 21 Cdo 500/2019 se senát odchyluje.",
      },
    ]);

    const passage = citationPassageIn({
      ast,
      citationText: "21 Cdo 500/2019",
      sectionText: "Sekce, kterou tento dokument nenese.",
    });

    expect(passage?.anchorId).toBe("p9");
    expect(passage?.mention).toBe("latest_of_several");
  });

  test("matches a citation the publisher broke across lines", () => {
    const citationText = "21 Cdo\n500/2019";
    const blockText = "Soud odkázal na rozsudek 21 Cdo 500/2019 a nic víc.";
    // Without flattening both sides the stored spelling is not a substring of
    // the block, which is the whole reason for the collapse.
    expect(blockText.includes(citationText)).toBe(false);

    expect(
      citationPassageIn({
        ast: astOf([{ anchorId: "p3", text: blockText }]),
        citationText,
        sectionText: undefined,
      })?.anchorId,
    ).toBe("p3");
  });

  test("is absent when no block carries the citation", () => {
    expect(
      citationPassageIn({
        ast: astOf([{ anchorId: "p1", text: "Nic k věci." }]),
        citationText: "21 Cdo 500/2019",
        sectionText: undefined,
      }),
    ).toBeNull();
  });

  test("is bounded, and keeps the citation inside what it returns", () => {
    const citationText = "21 Cdo 500/2019";
    const filler = "x".repeat(LIMITS.caseLawCitationPassageChars * 2);
    const passage = citationPassageIn({
      ast: astOf([
        { anchorId: "p4", text: `${filler} ${citationText} ${filler}` },
      ]),
      citationText,
      sectionText: undefined,
    });

    expect(passage?.text.length).toBe(LIMITS.caseLawCitationPassageChars);
    expect(passage?.text).toContain(citationText);
    // The block was longer than what travels with the citation, and an agent
    // reading this as the whole paragraph would be reading a cut one.
    expect(passage?.truncated).toBe(true);
  });

  test("is not marked truncated when the whole block fits", () => {
    const citationText = "21 Cdo 500/2019";
    const blockText = `Soud odkázal na ${citationText}.`;
    expect(blockText.length).toBeLessThan(LIMITS.caseLawCitationPassageChars);

    const passage = citationPassageIn({
      ast: astOf([{ anchorId: "p6", text: blockText }]),
      citationText,
      sectionText: undefined,
    });

    expect(passage?.truncated).toBe(false);
    expect(passage?.text).toBe(blockText);
  });

  test("keeps a citation at the very end of a long block", () => {
    const citationText = "21 Cdo 500/2019";
    const passage = citationPassageIn({
      ast: astOf([
        {
          anchorId: "p5",
          text: `${"x".repeat(LIMITS.caseLawCitationPassageChars * 2)} ${citationText}`,
        },
      ]),
      citationText,
      sectionText: undefined,
    });

    expect(passage?.text).toEndWith(citationText);
  });
});
