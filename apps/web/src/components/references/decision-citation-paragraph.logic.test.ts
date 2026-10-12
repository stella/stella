import { describe, expect, test } from "bun:test";

import { DECISION_READ_RESOLUTION } from "@stll/api-contract/case-law-decision-resolution";
import { toSafeId } from "@stll/api-contract/safe-id";
import type {
  DocumentAst,
  HeadingBlock,
  ParagraphBlock,
} from "@stll/legal-ast/document-ast";

import { citedCourtParagraphNumber } from "./decision-citation-paragraph.logic";
import type { DecisionCitationParagraphSource } from "./decision-citation-paragraph.logic";

const paragraph = (anchorId: string, number?: number): ParagraphBlock => ({
  id: anchorId,
  anchorId,
  type: "paragraph",
  inlines: [{ type: "text", text: anchorId }],
  plainText: anchorId,
  ...(number === undefined ? {} : { number }),
});

const heading = (anchorId: string): HeadingBlock => ({
  id: anchorId,
  anchorId,
  type: "heading",
  level: 2,
  inlines: [{ type: "text", text: anchorId }],
  plainText: anchorId,
});

const ast = (...blocks: DocumentAst["blocks"]): DocumentAst => ({
  version: 1,
  source: { system: "", documentId: "", webUrl: "", printUrl: "" },
  metadata: {
    caseNumber: null,
    ecli: null,
    court: null,
    decisionDate: null,
    decisionType: null,
    keywords: [],
    statutes: [],
  },
  blocks,
});

const direct = (documentAst: unknown) =>
  ({
    documentAst,
    resolution: { type: DECISION_READ_RESOLUTION.DIRECT },
  }) satisfies DecisionCitationParagraphSource;

// Block anchors count headings too: `p-8` is the eighth block, which the
// court numbered 6. A number taken from the anchor would read 8.
const numbered = ast(
  heading("h-1"),
  heading("h-2"),
  paragraph("p-3"),
  paragraph("p-4", 1),
  paragraph("p-5", 2),
  paragraph("p-6", 3),
  paragraph("p-7", 4),
  paragraph("p-8", 6),
);

describe("cited court paragraph number", () => {
  test("names the number the court printed on the cited block, not the anchor's counter", () => {
    expect(
      citedCourtParagraphNumber({
        decision: direct(numbered),
        anchorId: "p-8",
      }),
    ).toBe(6);
  });

  test("names nothing for a block the court left unnumbered", () => {
    expect(
      citedCourtParagraphNumber({
        decision: direct(numbered),
        anchorId: "p-3",
      }),
    ).toBeNull();
  });

  test("names nothing in a decision whose court numbers no paragraph", () => {
    const unnumbered = ast(paragraph("p-1"), paragraph("p-8"));
    expect(
      citedCourtParagraphNumber({
        decision: direct(unnumbered),
        anchorId: "p-8",
      }),
    ).toBeNull();
  });

  test("names nothing for a heading block", () => {
    expect(
      citedCourtParagraphNumber({
        decision: direct(numbered),
        anchorId: "h-2",
      }),
    ).toBeNull();
  });

  test("names nothing for an anchor the decision does not contain", () => {
    expect(
      citedCourtParagraphNumber({
        decision: direct(numbered),
        anchorId: "p-99",
      }),
    ).toBeNull();
  });

  test("names nothing without an anchor, a document, or a valid document", () => {
    expect(
      citedCourtParagraphNumber({
        decision: direct(numbered),
        anchorId: undefined,
      }),
    ).toBeNull();
    expect(
      citedCourtParagraphNumber({ decision: direct(null), anchorId: "p-8" }),
    ).toBeNull();
    expect(
      citedCourtParagraphNumber({
        decision: direct({ blocks: "not a document" }),
        anchorId: "p-8",
      }),
    ).toBeNull();
  });

  test("ignores a number that is not a positive whole number", () => {
    const malformed = ast(paragraph("p-1", 2.5), paragraph("p-2", 0));
    expect(
      citedCourtParagraphNumber({
        decision: direct(malformed),
        anchorId: "p-1",
      }),
    ).toBeNull();
    expect(
      citedCourtParagraphNumber({
        decision: direct(malformed),
        anchorId: "p-2",
      }),
    ).toBeNull();
  });

  test("finds absorbed reasons' block under its prefix in the judgment, never a substitute", () => {
    const prefix = "reasons-";
    const judgment = ast(
      paragraph("p-1", 1),
      paragraph(`${prefix}p-1`, 14),
      paragraph(`${prefix}p-2`, 15),
    );
    const absorbed = {
      documentAst: judgment,
      resolution: {
        type: DECISION_READ_RESOLUTION.ABSORBED_SUPPLEMENT,
        absorbedDecisionId: toSafeId<"caseLawDecision">(
          "019a0000-0000-7000-8000-000000000201",
        ),
        anchorPrefix: prefix,
      },
    } satisfies DecisionCitationParagraphSource;
    expect(
      citedCourtParagraphNumber({ decision: absorbed, anchorId: "p-2" }),
    ).toBe(15);
    expect(
      citedCourtParagraphNumber({ decision: absorbed, anchorId: "p-1" }),
    ).toBe(14);
    expect(
      citedCourtParagraphNumber({ decision: absorbed, anchorId: "p-3" }),
    ).toBeNull();
  });
});
