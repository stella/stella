/**
 * The fix is derived from the delta, never chosen by the model, so the tests
 * are about that derivation: which op each kind of difference produces, and
 * when the engine must refuse to produce one at all.
 */

import { describe, expect, test } from "bun:test";

import type { ReviewDelta } from "@/api/lib/document-review/review-delta";
import { buildGroundedReviewFix } from "@/api/lib/grounded-review-fix";

const BLOCK_TEXT =
  "Claims must be notified within 12 months of Completion, failing which they lapse.";

const anchors = [{ blockId: "p-1", text: BLOCK_TEXT }];

const parameterDelta = (
  targetText: string,
  standardText: string,
  blockText = BLOCK_TEXT,
): ReviewDelta => ({
  kind: "parameter",
  target: {
    text: targetText,
    value: 12,
    unit: "months",
    citation: { blockId: "p-1", text: blockText },
  },
  standard: {
    text: standardText,
    value: 6,
    unit: "months",
    citation: { blockId: "p-9", text: "within 6 months of Completion" },
  },
});

describe("buildGroundedReviewFix", () => {
  test("a parameter delta replaces the term inside its block", () => {
    expect(
      buildGroundedReviewFix({
        delta: parameterDelta("12 months", "6 months"),
        proposedText: null,
        supportingEvidenceVerified: true,
        targetAnchors: anchors,
      }),
    ).toEqual({
      kind: "replaceInBlock",
      blockId: "p-1",
      find: "12 months",
      replace: "6 months",
    });
  });

  // Two occurrences mean the engine cannot say which one the finding is about.
  // An editor must; guessing would silently rewrite the wrong term.
  test("an ambiguous term yields no fix", () => {
    expect(
      buildGroundedReviewFix({
        delta: parameterDelta(
          "12 months",
          "6 months",
          "Notify within 12 months; indemnity claims within 12 months.",
        ),
        proposedText: null,
        supportingEvidenceVerified: true,
        targetAnchors: anchors,
      }),
    ).toBeNull();
  });

  test("a term the cited block does not contain yields no fix", () => {
    expect(
      buildGroundedReviewFix({
        delta: parameterDelta("18 months", "6 months"),
        proposedText: null,
        supportingEvidenceVerified: true,
        targetAnchors: anchors,
      }),
    ).toBeNull();
  });

  test("a parameter delta with nothing on the target side yields no fix", () => {
    expect(
      buildGroundedReviewFix({
        delta: { kind: "parameter", target: null, standard: null },
        proposedText: "within 6 months",
        supportingEvidenceVerified: true,
        targetAnchors: anchors,
      }),
    ).toBeNull();
  });

  test("an enumeration delta inserts the missing limbs after the block", () => {
    expect(
      buildGroundedReviewFix({
        delta: {
          kind: "enumeration",
          items: [
            {
              label: "management fees",
              inTarget: false,
              inStandard: true,
              citation: null,
            },
          ],
        },
        proposedText: "(e) any management fees paid to a Seller Group company;",
        supportingEvidenceVerified: true,
        targetAnchors: anchors,
      }),
    ).toEqual({
      kind: "insertAfterBlock",
      blockId: "p-1",
      text: "(e) any management fees paid to a Seller Group company;",
    });
  });

  test("a presence delta inserts the absent term after the block", () => {
    expect(
      buildGroundedReviewFix({
        delta: {
          kind: "presence",
          term: "Losses",
          inTarget: false,
          inStandard: true,
        },
        proposedText: '"Losses" means all losses, liabilities and costs.',
        supportingEvidenceVerified: true,
        targetAnchors: anchors,
      }),
    ).toEqual({
      kind: "insertAfterBlock",
      blockId: "p-1",
      text: '"Losses" means all losses, liabilities and costs.',
    });
  });

  test("a language delta replaces the whole block", () => {
    expect(
      buildGroundedReviewFix({
        delta: { kind: "language" },
        proposedText: "Fairly Disclosed means disclosed in sufficient detail.",
        supportingEvidenceVerified: true,
        targetAnchors: anchors,
      }),
    ).toEqual({
      kind: "replaceBlock",
      blockId: "p-1",
      text: "Fairly Disclosed means disclosed in sufficient detail.",
    });
  });

  test("does not insert a standard written in another language", () => {
    const czechTarget = [
      {
        blockId: "p-1",
        text: "Poskytovatel odpovídá za škodu způsobenou porušením této smlouvy a nahradí ji objednateli.",
      },
    ];

    expect(
      buildGroundedReviewFix({
        delta: { kind: "language" },
        proposedText:
          "The provider is liable for damage caused by a breach of this agreement and shall compensate the customer.",
        supportingEvidenceVerified: true,
        targetAnchors: czechTarget,
      }),
    ).toBeNull();
  });

  test("allows a cross-language replacement only when explicitly requested", () => {
    expect(
      buildGroundedReviewFix({
        delta: { kind: "language" },
        proposedText: "The provider is liable for damage caused by a breach.",
        supportingEvidenceVerified: true,
        targetAnchors: [
          {
            blockId: "p-1",
            text: "Poskytovatel odpovídá za škodu způsobenou porušením této smlouvy a nahradí ji objednateli.",
          },
        ],
        translationRequested: true,
      }),
    ).toEqual({
      kind: "replaceBlock",
      blockId: "p-1",
      text: "The provider is liable for damage caused by a breach.",
    });
  });

  test("an ungrounded conclusion never becomes an executable edit", () => {
    expect(
      buildGroundedReviewFix({
        delta: { kind: "language" },
        proposedText: "Some replacement.",
        supportingEvidenceVerified: false,
        targetAnchors: anchors,
      }),
    ).toBeNull();
  });

  test("no anchor and no proposed text both yield no fix", () => {
    expect(
      buildGroundedReviewFix({
        delta: { kind: "language" },
        proposedText: "Some replacement.",
        supportingEvidenceVerified: true,
        targetAnchors: [],
      }),
    ).toBeNull();
    expect(
      buildGroundedReviewFix({
        delta: { kind: "language" },
        proposedText: "   ",
        supportingEvidenceVerified: true,
        targetAnchors: anchors,
      }),
    ).toBeNull();
  });
});
