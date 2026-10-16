import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import type { DocumentAst } from "@stll/legal-ast/document-ast";
import { assertProperty } from "@stll/property-testing";

import {
  citationPassageIn,
  passageTextEligibility,
  citationTextFields,
  readCitationDecisionText,
  polarityExcerptIn,
} from "@/api/handlers/case-law/decisions/citation-passages";
import { createSafeId } from "@/api/lib/branded-types";
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
      sectionText: undefined,
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
      sectionText: undefined,
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
      sectionText: undefined,
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
      sectionText: undefined,
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
      sectionText: classified,
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
      sectionText: undefined,
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
      sectionText: undefined,
      evidenceQuote: "Different facts.",
    });
    expect(passage).not.toHaveProperty("evidenceQuote");
  });

  test("is absent when no paragraph carries the citation", () => {
    expect(
      citationPassageIn({
        ast: astOf([{ anchorId: "p1", text: "Nic k věci." }]),
        citationText: "21 Cdo 500/2019",
        sectionText: undefined,
      }),
    ).toBeNull();
  });
});

describe("stored polarity evidence windows", () => {
  test("slice the original joined sections across Unicode and section boundaries", () => {
    assertProperty(
      "slice the original joined sections across Unicode and section boundaries",
      fc.property(
        fc.array(
          fc
            .array(
              fc.constantFrom("ě", "😀", "e\u0301", " ", "\n", "\t", "X"),
              { minLength: 1, maxLength: 40 },
            )
            .map((characters) => characters.join("")),
          { minLength: 1, maxLength: 8 },
        ),
        fc.nat(),
        fc.nat(),
        (texts, first, second) => {
          const text = texts.join("\n");
          const start = first % text.length;
          const end = start + 1 + (second % (text.length - start));
          const sections = texts.map((sectionText, index) => ({
            index,
            text: sectionText,
            type: "unknown" as const,
            title: null,
          }));
          expect(
            polarityExcerptIn({ sections, evidenceWindows: [{ start, end }] }),
          ).toBe(text.slice(start, end));
        },
      ),
    );
  });

  test("unknown offsets never substitute a display passage", () => {
    const sections = [
      {
        index: 0,
        text: "Synthetic citation window",
        type: "unknown" as const,
        title: null,
      },
    ];
    expect(polarityExcerptIn({ sections, evidenceWindows: null })).toBeNull();
    expect(
      polarityExcerptIn({
        sections: null,
        evidenceWindows: [{ start: 0, end: 2 }],
      }),
    ).toBeNull();
    expect(
      polarityExcerptIn({ sections, evidenceWindows: [{ start: -1, end: 2 }] }),
    ).toBeNull();
    expect(
      polarityExcerptIn({ sections, evidenceWindows: [{ start: 2, end: 1 }] }),
    ).toBeNull();
  });
});

test("widely separated polarity mentions return bounded evidence with an explicit omission", () => {
  const prefix = "Synthetic rejection 😀 ";
  const suffix = " Separate opinion conclusion.";
  const original =
    prefix + "middle ".repeat(LIMITS.caseLawCitationPassageChars) + suffix;
  const excerpt = polarityExcerptIn({
    sections: [
      { index: 0, text: original, type: "argumentation", title: null },
    ],
    evidenceWindows: [{ start: 0, end: original.length }],
  });
  expect(excerpt?.length).toBe(LIMITS.caseLawCitationPassageChars);
  expect(excerpt).toStartWith(prefix);
  expect(excerpt).toEndWith(suffix);
  expect(excerpt).toContain("\n[…]\n");
});

test("every long evidence window stays bounded and preserves both recorded ends", () => {
  assertProperty(
    "every long evidence window stays bounded and preserves both recorded ends",
    fc.property(
      fc.integer({
        min: LIMITS.caseLawCitationPassageChars + 1,
        max: LIMITS.caseLawCitationPassageChars * 10,
      }),
      fc.constantFrom("ě", "😀", "e\u0301", "\t", " "),
      (length, character) => {
        const prefix = "Synthetic first mention ";
        const suffix = " Synthetic last mention";
        const text = prefix + character.repeat(length) + suffix;
        const excerpt = polarityExcerptIn({
          sections: [{ index: 0, text, type: "argumentation", title: null }],
          evidenceWindows: [{ start: 0, end: text.length }],
        });
        expect(excerpt?.length).toBeLessThanOrEqual(
          LIMITS.caseLawCitationPassageChars,
        );
        expect(excerpt).toStartWith(prefix);
        expect(excerpt).toEndWith(suffix);
        expect(excerpt).toContain("\n[…]\n");
      },
    ),
  );
});

test("a text-eligibility failure returns no citation text and an incomplete reason", async () => {
  const citationText = "21 Cdo 500/2019";
  const paragraph = `Synthetic reasoning in ${citationText}.`;
  const ast = astOf([{ anchorId: "p1", text: paragraph }]);
  const text = await readCitationDecisionText({
    pointer: {
      id: createSafeId<"caseLawDecision">(),
      astS3Key: "synthetic/ast",
      contentHash: "synthetic-hash",
      textEligibilityFingerprint: "synthetic-revision",
    },
    columns: {
      textWithheldReason: null,
      contentHash: "synthetic-hash",
      textEligibilityFingerprint: "synthetic-revision",
      documentAst: ast,
      sections: [
        { index: 0, text: paragraph, type: "argumentation", title: null },
      ],
    },
    readAst: async () =>
      await Promise.reject(new TypeError("Synthetic read failure")),
  });
  expect(
    citationTextFields({
      text,
      textWithheldReason: null,
      citationText,
      sectionIndex: 0,
      evidenceWindows: [{ start: 0, end: paragraph.length }],
    }),
  ).toEqual({
    citationText: null,
    passage: null,
    evidenceExcerpt: null,
    textIncompleteReason: "gate_failed",
  });
});

test("an absent analysis retains eligible citation text without excerpts", () => {
  expect(
    citationTextFields({
      text: { type: "absent-ast" },
      textWithheldReason: null,
      citationText: "21 Cdo 500/2019",
      sectionIndex: 0,
      evidenceWindows: [{ start: 0, end: 10 }],
    }),
  ).toEqual({
    citationText: "21 Cdo 500/2019",
    passage: null,
    evidenceExcerpt: null,
    textIncompleteReason: "absent_ast",
  });
});

test("eligible citation text preserves doctrine evidence without polarity windows", () => {
  const citationText = "21 Cdo 500/2019";
  const evidenceQuote = "The earlier decision concerns different facts.";
  const fields = citationTextFields({
    text: {
      type: "eligible",
      ast: astOf([
        { anchorId: "citation", text: `See ${citationText}.` },
        { anchorId: "doctrine", text: evidenceQuote },
      ]),
      sections: null,
    },
    citationText,
    sectionIndex: null,
    textWithheldReason: null,
    evidenceWindows: null,
    evidenceQuote,
  });
  expect(fields.evidenceExcerpt).toBeNull();
  expect(fields.passage).toMatchObject({
    anchorId: "citation",
    evidenceQuote,
    evidenceAnchorId: "doctrine",
  });
});

test("a citing decision country change invalidates text even within the admitted surface", async () => {
  const eligibility = {
    published: true,
    redistributable: true,
    textRevisionFingerprint: "same-text-revision",
    descriptor: { allowsDerivedAi: true },
  };
  const original = passageTextEligibility({ ...eligibility, country: "CZE" });
  const changed = passageTextEligibility({ ...eligibility, country: "SVK" });
  expect(changed.textEligibilityFingerprint).not.toBe(
    original.textEligibilityFingerprint,
  );
  let astReads = 0;
  const text = await readCitationDecisionText({
    pointer: {
      id: createSafeId<"caseLawDecision">(),
      astS3Key: null,
      contentHash: "same-content-hash",
      textEligibilityFingerprint: original.textEligibilityFingerprint,
    },
    columns: {
      ...changed,
      contentHash: "same-content-hash",
      documentAst: null,
      sections: null,
    },
    readAst: async () => {
      astReads += 1;
      return await Promise.resolve(null);
    },
  });
  expect(astReads).toBe(0);
  expect(
    citationTextFields({
      text,
      citationText: "21 Cdo 500/2019",
      sectionIndex: null,
      textWithheldReason: null,
      evidenceWindows: null,
      evidenceQuote: "Synthetic doctrine evidence.",
    }),
  ).toEqual({
    citationText: null,
    passage: null,
    evidenceExcerpt: null,
    textIncompleteReason: "text_changed",
  });
});
