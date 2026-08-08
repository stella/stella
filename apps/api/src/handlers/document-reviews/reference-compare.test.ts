import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  normalizeReferenceReview,
  referenceReviewSchema,
} from "@/api/handlers/document-reviews/reference-compare";
import { toSafeId } from "@/api/lib/branded-types";

const targetFieldId = toSafeId<"field">("target-field");
const referenceFieldId = toSafeId<"field">("reference-field");
const topicId = "11111111-1111-4111-8111-111111111111";
const topics = [
  {
    type: "custom" as const,
    topicId,
    title: "Liability",
    context: "",
    included: true,
  },
];

const target = {
  kind: "docx" as const,
  fileFieldId: targetFieldId,
  fileId: "target-file",
  simplifiedName: "F0",
  blocks: [
    { id: "target-1", kind: "paragraph" as const, text: "Target clause" },
    { id: "target-2", kind: "paragraph" as const, text: "Target ending" },
  ],
};

const reference = {
  kind: "docx" as const,
  fileFieldId: referenceFieldId,
  fileId: "reference-file",
  simplifiedName: "F1",
  blocks: [
    {
      id: "reference-1",
      kind: "paragraph" as const,
      text: "Reference clause",
    },
  ],
};

describe("reference review normalization", () => {
  test("accepts excess model citations and bounds the trusted result", () => {
    const blocks = Array.from({ length: 10 }, (_, index) => ({
      id: `target-${String(index + 1)}`,
      kind: "paragraph" as const,
      text: `Invented clause ${String(index + 1)}`,
    }));
    const rawFinding = {
      topicId,
      assessment: "aligned" as const,
      consensus: "single" as const,
      rationale: "Comparable.",
      targetCitations: blocks.map((block) => ({
        sourceKey: "F0",
        blockId: block.id,
      })),
      referenceCitations: [],
      proposedText: null,
    };

    const parsed = v.parse(referenceReviewSchema, {
      findings: Array.from({ length: 51 }, () => rawFinding),
    });
    const findings = normalizeReferenceReview({
      target: { ...target, blocks },
      references: [reference],
      topics,
      rawFindings: parsed.findings,
    });

    expect(findings).toHaveLength(1);
    expect(findings.at(0)?.targetCitations).toHaveLength(8);
  });

  test("keeps only verified source-specific citations and derives target fixes", () => {
    const findings = normalizeReferenceReview({
      target,
      references: [reference],
      topics,
      rawFindings: [
        {
          topicId,
          assessment: "different",
          consensus: "mixed",
          rationale: " Different allocation. ",
          targetCitations: [
            { sourceKey: "F0", blockId: "target-1" },
            { sourceKey: "F1", blockId: "reference-1" },
            { sourceKey: "F0", blockId: "invented" },
          ],
          referenceCitations: [
            { sourceKey: "F1", blockId: "reference-1" },
            { sourceKey: "F0", blockId: "target-1" },
          ],
          proposedText: "Use the reference allocation.",
        },
      ],
    });

    expect(findings).toEqual([
      {
        findingId: `reference-${topicId}`,
        topicId,
        issue: "Liability",
        assessment: "different",
        consensus: "single",
        rationale: "Different allocation.",
        targetCitations: [{ blockId: "target-1", text: "Target clause" }],
        referenceCitations: [
          {
            fileFieldId: referenceFieldId,
            citations: [{ blockId: "reference-1", text: "Reference clause" }],
          },
        ],
        fix: {
          kind: "replaceBlock",
          blockId: "target-1",
          text: "Use the reference allocation.",
        },
      },
    ]);
  });

  test("never uses a reference citation as a replacement anchor", () => {
    const findings = normalizeReferenceReview({
      target,
      references: [reference],
      topics,
      rawFindings: [
        {
          topicId,
          assessment: "different",
          consensus: "single",
          rationale: "Different allocation.",
          targetCitations: [],
          referenceCitations: [{ sourceKey: "F1", blockId: "reference-1" }],
          proposedText: "Reference wording",
        },
      ],
    });

    expect(findings.at(0)?.fix).toBeNull();
  });

  test("anchors a missing-clause suggestion only after the target's last block", () => {
    const findings = normalizeReferenceReview({
      target,
      references: [reference],
      topics: [
        {
          type: "custom",
          topicId,
          title: "Notice",
          context: "",
          included: true,
        },
      ],
      rawFindings: [
        {
          topicId,
          assessment: "missing-from-target",
          consensus: "single",
          rationale: "The reference contains a notice clause.",
          targetCitations: [],
          referenceCitations: [{ sourceKey: "F1", blockId: "reference-1" }],
          proposedText: "Notice wording",
        },
      ],
    });

    expect(findings.at(0)?.fix).toEqual({
      kind: "insertAfterBlock",
      blockId: "target-2",
      text: "Notice wording",
    });
  });

  test("returns a not-comparable result when no citation is grounded", () => {
    const findings = normalizeReferenceReview({
      target,
      references: [reference],
      topics,
      rawFindings: [
        {
          topicId,
          assessment: "not-comparable",
          consensus: "single",
          rationale: "Unsupported",
          targetCitations: [{ sourceKey: "F0", blockId: "unknown" }],
          referenceCitations: [{ sourceKey: "F2", blockId: "unknown" }],
          proposedText: null,
        },
      ],
    });

    expect(findings).toEqual([
      {
        findingId: `reference-${topicId}`,
        topicId,
        issue: "Liability",
        assessment: "not-comparable",
        consensus: "single",
        rationale:
          "The supplied documents do not provide grounded evidence for this topic.",
        targetCitations: [],
        referenceCitations: [],
        fix: null,
      },
    ]);
  });

  test("returns exactly one result for every confirmed topic", () => {
    const secondTopicId = "22222222-2222-4222-8222-222222222222";
    const findings = normalizeReferenceReview({
      target,
      references: [reference],
      topics: [
        ...topics,
        {
          type: "custom",
          topicId: secondTopicId,
          title: "Notices",
          context: "",
          included: true,
        },
      ],
      rawFindings: [
        {
          topicId,
          assessment: "aligned",
          consensus: "single",
          rationale: "Comparable.",
          targetCitations: [{ sourceKey: "F0", blockId: "target-1" }],
          referenceCitations: [{ sourceKey: "F1", blockId: "reference-1" }],
          proposedText: null,
        },
        {
          topicId,
          assessment: "different",
          consensus: "single",
          rationale: "Duplicate model row.",
          targetCitations: [{ sourceKey: "F0", blockId: "target-1" }],
          referenceCitations: [],
          proposedText: null,
        },
      ],
    });

    expect(findings.map((finding) => finding.topicId)).toEqual([
      topicId,
      secondTopicId,
    ]);
  });
});
