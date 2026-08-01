import { describe, expect, test } from "bun:test";

import { normalizeReferenceReview } from "@/api/handlers/document-reviews/reference-compare";
import { toSafeId } from "@/api/lib/branded-types";

const targetFieldId = toSafeId<"field">("target-field");
const referenceFieldId = toSafeId<"field">("reference-field");

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
  test("keeps only verified source-specific citations and derives target fixes", () => {
    const findings = normalizeReferenceReview({
      target,
      references: [reference],
      rawFindings: [
        {
          issue: " Liability ",
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
        findingId: "reference-1",
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
      rawFindings: [
        {
          issue: "Liability",
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
      rawFindings: [
        {
          issue: "Notice",
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

  test("drops findings without any verified citation", () => {
    const findings = normalizeReferenceReview({
      target,
      references: [reference],
      rawFindings: [
        {
          issue: "Invented issue",
          assessment: "not-comparable",
          consensus: "single",
          rationale: "Unsupported",
          targetCitations: [{ sourceKey: "F0", blockId: "unknown" }],
          referenceCitations: [{ sourceKey: "F2", blockId: "unknown" }],
          proposedText: null,
        },
      ],
    });

    expect(findings).toEqual([]);
  });
});
