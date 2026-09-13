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
    const passage = citationPassageIn(
      astOf([
        { anchorId: "p1", text: "Úvod bez citace." },
        {
          anchorId: "p2",
          text: "Soud vyšel z rozsudku 21 Cdo 500/2019 a dovodil, že nárok trvá.",
        },
      ]),
      "21 Cdo 500/2019",
    );

    expect(passage).toEqual({
      anchorId: "p2",
      text: "Soud vyšel z rozsudku 21 Cdo 500/2019 a dovodil, že nárok trvá.",
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

    expect(citationPassageIn(ast, "21 Cdo 500/2019")?.anchorId).toBe("p9");
  });

  test("matches a citation the publisher broke across lines", () => {
    const citationText = "21 Cdo\n500/2019";
    const blockText = "Soud odkázal na rozsudek 21 Cdo 500/2019 a nic víc.";
    // Without flattening both sides the stored spelling is not a substring of
    // the block, which is the whole reason for the collapse.
    expect(blockText.includes(citationText)).toBe(false);

    expect(
      citationPassageIn(
        astOf([{ anchorId: "p3", text: blockText }]),
        citationText,
      )?.anchorId,
    ).toBe("p3");
  });

  test("is absent when no block carries the citation", () => {
    expect(
      citationPassageIn(
        astOf([{ anchorId: "p1", text: "Nic k věci." }]),
        "21 Cdo 500/2019",
      ),
    ).toBeNull();
  });

  test("is bounded, and keeps the citation inside what it returns", () => {
    const citationText = "21 Cdo 500/2019";
    const filler = "x".repeat(LIMITS.caseLawCitationPassageChars * 2);
    const passage = citationPassageIn(
      astOf([{ anchorId: "p4", text: `${filler} ${citationText} ${filler}` }]),
      citationText,
    );

    expect(passage?.text.length).toBe(LIMITS.caseLawCitationPassageChars);
    expect(passage?.text).toContain(citationText);
  });

  test("keeps a citation at the very end of a long block", () => {
    const citationText = "21 Cdo 500/2019";
    const passage = citationPassageIn(
      astOf([
        {
          anchorId: "p5",
          text: `${"x".repeat(LIMITS.caseLawCitationPassageChars * 2)} ${citationText}`,
        },
      ]),
      citationText,
    );

    expect(passage?.text).toEndWith(citationText);
  });
});
