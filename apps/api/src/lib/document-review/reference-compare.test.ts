import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { toSafeId } from "@/api/lib/branded-types";
import {
  normalizeReferenceReview,
  referenceReviewSchema,
} from "@/api/lib/document-review/reference-compare";

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

const secondReference = {
  ...reference,
  fileFieldId: toSafeId<"field">("second-reference-field"),
  fileId: "second-reference-file",
  simplifiedName: "F2",
  blocks: [
    {
      id: "reference-2",
      kind: "paragraph" as const,
      text: "Alternative example clause",
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
      recommendation: "",
      impact: "neutral" as const,
      severity: "low" as const,
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
          recommendation: " Align the allocation with the reference. ",
          impact: "unfavourable",
          severity: "high",
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
        explanation: { type: "comparison", text: "Different allocation." },
        recommendation: "Align the allocation with the reference.",
        impact: "unfavourable",
        severity: "high",
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

  test("never exposes single-document consensus for multiple references", () => {
    const findings = normalizeReferenceReview({
      target,
      references: [reference, secondReference],
      topics,
      rawFindings: [
        {
          topicId,
          assessment: "aligned",
          consensus: "single",
          rationale: "The examples use the same approach.",
          recommendation: "",
          impact: "neutral",
          severity: "low",
          targetCitations: [{ sourceKey: "F0", blockId: "target-1" }],
          referenceCitations: [
            { sourceKey: "F1", blockId: "reference-1" },
            { sourceKey: "F2", blockId: "reference-2" },
          ],
          proposedText: null,
        },
      ],
    });

    expect(findings.at(0)?.consensus).toBe("consistent");
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
          recommendation: "Adopt the reference wording.",
          impact: "unfavourable",
          severity: "medium",
          targetCitations: [],
          referenceCitations: [{ sourceKey: "F1", blockId: "reference-1" }],
          proposedText: "Reference wording",
        },
      ],
    });

    expect(findings.at(0)?.fix).toBeNull();
  });

  test("does not trust a comparison or edit without reference evidence", () => {
    const findings = normalizeReferenceReview({
      target,
      references: [reference],
      topics,
      rawFindings: [
        {
          topicId,
          assessment: "different",
          consensus: "single",
          rationale: "Purported difference without precedent support.",
          recommendation: "Change it anyway.",
          impact: "unfavourable",
          severity: "high",
          targetCitations: [{ sourceKey: "F0", blockId: "target-1" }],
          referenceCitations: [],
          proposedText: "Unsupported replacement wording.",
        },
      ],
    });

    expect(findings.at(0)).toMatchObject({
      assessment: "not-comparable",
      fix: null,
      explanation: { type: "insufficient-evidence" },
      // Nothing grounded means nothing to act on and no direction to report.
      recommendation: null,
      impact: "unknown",
    });
  });

  test("does not invent a document-end anchor for a missing clause", () => {
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
          recommendation: "Add a notice clause.",
          impact: "unfavourable",
          severity: "medium",
          targetCitations: [],
          referenceCitations: [{ sourceKey: "F1", blockId: "reference-1" }],
          proposedText: "Notice wording",
        },
      ],
    });

    expect(findings.at(0)?.fix).toBeNull();
  });

  test("anchors a missing-clause suggestion only to a verified target citation", () => {
    const findings = normalizeReferenceReview({
      target,
      references: [reference],
      topics,
      rawFindings: [
        {
          topicId,
          assessment: "missing-from-target",
          consensus: "single",
          rationale: "The reference contains a clause absent from the target.",
          recommendation: "Insert the clause after the definitions.",
          impact: "unfavourable",
          severity: "medium",
          targetCitations: [{ sourceKey: "F0", blockId: "target-1" }],
          referenceCitations: [{ sourceKey: "F1", blockId: "reference-1" }],
          proposedText: "Suggested clause wording",
        },
      ],
    });

    expect(findings.at(0)?.fix).toEqual({
      kind: "insertAfterBlock",
      blockId: "target-1",
      text: "Suggested clause wording",
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
          recommendation: "",
          impact: "unknown",
          severity: "low",
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
        explanation: { type: "insufficient-evidence" },
        recommendation: null,
        impact: "unknown",
        severity: "low",
        targetCitations: [],
        referenceCitations: [],
        fix: null,
      },
    ]);
  });

  test("returns exactly one result per confirmed topic in confirmed order", () => {
    const secondTopicId = "22222222-2222-4222-8222-222222222222";
    const confirmedTopics = [
      ...topics,
      {
        type: "custom" as const,
        topicId: secondTopicId,
        title: "Notices",
        context: "",
        included: true,
      },
    ];
    const findings = normalizeReferenceReview({
      target,
      references: [reference],
      topics: confirmedTopics,
      rawFindings: [
        {
          topicId: secondTopicId,
          assessment: "aligned",
          consensus: "single",
          rationale: "Comparable.",
          recommendation: "",
          impact: "neutral",
          severity: "low",
          targetCitations: [{ sourceKey: "F0", blockId: "target-2" }],
          referenceCitations: [{ sourceKey: "F1", blockId: "reference-1" }],
          proposedText: null,
        },
        {
          topicId,
          assessment: "aligned",
          consensus: "single",
          rationale: "Comparable.",
          recommendation: "",
          impact: "neutral",
          severity: "low",
          targetCitations: [{ sourceKey: "F0", blockId: "target-1" }],
          referenceCitations: [{ sourceKey: "F1", blockId: "reference-1" }],
          proposedText: null,
        },
        {
          topicId,
          assessment: "different",
          consensus: "single",
          rationale: "Duplicate model row.",
          recommendation: "",
          impact: "unfavourable",
          severity: "low",
          targetCitations: [{ sourceKey: "F0", blockId: "target-1" }],
          referenceCitations: [],
          proposedText: null,
        },
      ],
    });

    expect(findings.map(({ topicId: id }) => id)).toEqual(
      confirmedTopics.map(({ topicId: id }) => id),
    );
  });
});
