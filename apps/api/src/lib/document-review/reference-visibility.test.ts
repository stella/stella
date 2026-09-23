import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import {
  findingForReader,
  referencesForReader,
  referenceWorkspacesByPosition,
} from "@/api/lib/document-review/reference-visibility";
import type { ReviewFinding } from "@/api/lib/document-review/review-grade";
import type {
  DocumentReviewRunBasis,
  PinnedReference,
} from "@/api/lib/document-review/run-contract";

const REFERENCE_WORKSPACE = "11111111-1111-4111-8111-111111111111";
const OTHER_REFERENCE_WORKSPACE = "22222222-2222-4222-8222-222222222222";
const REFERENCE_POSITION = "33333333-3333-4333-8333-333333333333";
const TIERS_POSITION = "44444444-4444-4444-8444-444444444444";

const passage = (workspaceId: string) => ({
  id: Bun.randomUUIDv7(),
  workspaceId,
  entityId: Bun.randomUUIDv7(),
  fileFieldId: Bun.randomUUIDv7(),
  entityVersionId: Bun.randomUUIDv7(),
  blockId: "b-1",
});

const reference: PinnedReference = {
  workspaceId: toSafeId<"workspace">(REFERENCE_WORKSPACE),
  workspaceName: "Precedent matter",
  entityId: toSafeId<"entity">(Bun.randomUUIDv7()),
  fileFieldId: toSafeId<"field">(Bun.randomUUIDv7()),
  entityVersionId: toSafeId<"entityVersion">(Bun.randomUUIDv7()),
  contentSha256: "a".repeat(64),
  name: "Precedent SPA",
};

const basis: DocumentReviewRunBasis = {
  playbook: {
    definitionId: null,
    versionId: null,
    provenance: "ephemeral",
    definitionSnapshot: {
      name: "Positions confirmed for this review",
      positions: {
        version: 3,
        items: [
          {
            mode: "graded",
            sourceId: REFERENCE_POSITION,
            issue: "Claims time bar",
            severity: "high",
            standard: {
              source: "reference",
              termKind: "parameter",
              passages: [
                passage(REFERENCE_WORKSPACE),
                passage(OTHER_REFERENCE_WORKSPACE),
              ],
            },
            ask: { mode: "auto" },
            enabled: true,
          },
        ],
      },
    },
  },
  references: [reference],
  perspective: { type: "neutral" },
};

const referenceFinding: ReviewFinding = {
  positionId: REFERENCE_POSITION,
  issue: "Claims time bar",
  severity: "high",
  standardSource: "reference",
  verdict: "deviation",
  delta: {
    kind: "parameter",
    target: {
      text: "12 months",
      value: 12,
      unit: "months",
      citation: { blockId: "t-1", text: "Claims within 12 months." },
    },
    standard: {
      text: "24 months",
      value: 24,
      unit: "months",
      citation: { blockId: "b-1", text: "Claims within 24 months." },
    },
  },
  extracted: null,
  rationale: null,
  consensus: "single",
  impact: "unfavourable",
  explanation: { type: "comparison", text: "The standard allows 24 months." },
  recommendation: "Extend the period to 24 months.",
  citations: [{ blockId: "t-1", text: "Claims within 12 months." }],
  referenceCitations: [
    {
      fileFieldId: toSafeId<"field">(Bun.randomUUIDv7()),
      passages: [{ id: Bun.randomUUIDv7(), blockId: "b-1" }],
    },
  ],
  fix: {
    kind: "replaceBlock",
    blockId: "t-1",
    text: "Claims within 24 months.",
  },
};

const positionWorkspaces = referenceWorkspacesByPosition(basis);

describe("findingForReader", () => {
  test("returns the finding unchanged when every reference matter is readable", () => {
    const readable = new Set([REFERENCE_WORKSPACE, OTHER_REFERENCE_WORKSPACE]);

    expect(
      findingForReader(referenceFinding, { positionWorkspaces, readable }),
    ).toBe(referenceFinding);
  });

  test("keeps the target-side verdict and drops fields written from the reference", () => {
    const readable = new Set([REFERENCE_WORKSPACE]);

    const shown = findingForReader(referenceFinding, {
      positionWorkspaces,
      readable,
    });

    expect(shown).toMatchObject({
      positionId: REFERENCE_POSITION,
      verdict: "deviation",
      citations: referenceFinding.citations,
      delta: { kind: "language" },
      rationale: null,
      recommendation: null,
      referenceCitations: [],
      fix: null,
      referenceDetail: "withheld",
    });
    expect(shown.explanation).toBeUndefined();
    expect(shown.impact).toBeUndefined();
    expect(JSON.stringify(shown)).not.toContain("24 months");
  });

  test("leaves findings for positions without reference passages alone", () => {
    const tiersFinding: ReviewFinding = {
      ...referenceFinding,
      positionId: TIERS_POSITION,
      standardSource: "tiers",
    };

    expect(
      findingForReader(tiersFinding, {
        positionWorkspaces,
        readable: new Set(),
      }),
    ).toBe(tiersFinding);
  });
});

describe("referencesForReader", () => {
  test("keeps ids and drops names of references outside the readable set", () => {
    expect(referencesForReader([reference], new Set())).toEqual([
      { ...reference, workspaceName: null, name: null },
    ]);
    expect(
      referencesForReader([reference], new Set([REFERENCE_WORKSPACE])),
    ).toEqual([reference]);
  });
});
