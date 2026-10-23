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

/**
 * Which block a citation is read from is `findCitationPassage`'s rule and is
 * covered in `@stll/legal-ast`. What this read owns is how much of that block
 * travels with an agent-facing citation.
 */
describe("the excerpt a citation travels with", () => {
  test("is the whole paragraph when it fits, and says it was not cut", () => {
    const citationText = "21 Cdo 500/2019";
    const blockText = `Soud odkázal na ${citationText}.`;
    expect(blockText.length).toBeLessThan(LIMITS.caseLawCitationPassageChars);

    const passage = citationPassageIn({
      ast: astOf([{ anchorId: "p1", text: blockText }]),
      citationText,
    });

    expect(passage).toEqual({
      anchorId: "p1",
      text: blockText,
      truncated: false,
      mention: "sole",
    });
  });

  test("is bounded, keeps the citation inside it, and says it was cut", () => {
    const citationText = "21 Cdo 500/2019";
    const filler = "x".repeat(LIMITS.caseLawCitationPassageChars * 2);
    const passage = citationPassageIn({
      ast: astOf([
        { anchorId: "p4", text: `${filler} ${citationText} ${filler}` },
      ]),
      citationText,
    });

    expect(passage?.text.length).toBe(LIMITS.caseLawCitationPassageChars);
    expect(passage?.text).toContain(citationText);
    // An agent reading this as the whole paragraph would be reading a cut one.
    expect(passage?.truncated).toBe(true);
  });

  test("keeps a citation at the very end of a long paragraph", () => {
    const citationText = "21 Cdo 500/2019";
    const passage = citationPassageIn({
      ast: astOf([
        {
          anchorId: "p5",
          text: `${"x".repeat(LIMITS.caseLawCitationPassageChars * 2)} ${citationText}`,
        },
      ]),
      citationText,
    });

    expect(passage?.text).toEndWith(citationText);
  });

  test("carries the mention the shared rule reported", () => {
    const passage = citationPassageIn({
      ast: astOf([
        { anchorId: "p1", text: "Přehled: 21 Cdo 500/2019." },
        {
          anchorId: "p9",
          text: "Od závěrů rozsudku 21 Cdo 500/2019 se senát odchyluje.",
        },
      ]),
      citationText: "21 Cdo 500/2019",
    });

    expect(passage?.anchorId).toBe("p9");
    expect(passage?.mention).toBe("latest_of_several");
  });

  test("keeps the review quote verbatim beside the canonical citation excerpt", () => {
    const evidenceQuote = "The earlier decision concerns different facts.";
    const classified = "The court cites 21 Cdo 500/2019.";
    const passage = citationPassageIn({
      ast: astOf([
        { anchorId: "p1", text: classified },
        { anchorId: "p2", text: `21 Cdo 500/2019: ${evidenceQuote}` },
      ]),
      citationText: "21 Cdo 500/2019",
      classifiedBlockIds: ["b0"],
      evidenceQuote,
    });
    expect(passage).toEqual({
      anchorId: "p1",
      text: classified,
      mention: "classified_section",
      truncated: false,
      evidenceQuote,
      evidenceAnchorId: "p2",
    });
  });

  test("anchors a review quote in a paragraph that does not repeat the citation", () => {
    const evidenceQuote = "That ruling concerned a different contract.";
    const citing = "The court cites 21 Cdo 500/2019.";
    const passage = citationPassageIn({
      ast: astOf([
        { anchorId: "p1", text: citing },
        { anchorId: "p2", text: `However, ${evidenceQuote}` },
      ]),
      citationText: "21 Cdo 500/2019",
      evidenceQuote,
    });
    expect(passage).toMatchObject({
      anchorId: "p1",
      evidenceQuote,
      evidenceAnchorId: "p2",
    });
  });

  test("does not publish a quote absent from the decision text", () => {
    const passage = citationPassageIn({
      ast: astOf([{ anchorId: "p1", text: "21 Cdo 500/2019 is cited." }]),
      citationText: "21 Cdo 500/2019",
      evidenceQuote: "Different facts.",
    });
    expect(passage).not.toHaveProperty("evidenceQuote");
  });

  test("is absent when no paragraph carries the citation", () => {
    expect(
      citationPassageIn({
        ast: astOf([{ anchorId: "p1", text: "Nic k věci." }]),
        citationText: "21 Cdo 500/2019",
      }),
    ).toBeNull();
  });
});
