import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { NEUTRAL_PERSPECTIVE } from "@/api/lib/document-review/contract";
import { buildIssuesTableRows } from "@/api/lib/document-review/issues-table";
import {
  basisReferenceWorkspaceIds,
  createReferenceScope,
} from "@/api/lib/document-review/reference-access";
import type {
  DocumentReviewFindingPayload,
  DocumentReviewRunBasis,
} from "@/api/lib/document-review/run-contract";

const OWN_WORKSPACE_ID = toSafeId<"workspace">(
  "11111111-1111-4111-8111-111111111111",
);
const OTHER_WORKSPACE_ID = toSafeId<"workspace">(
  "22222222-2222-4222-8222-222222222222",
);
const OWN_FIELD_ID = toSafeId<"field">("33333333-3333-4333-8333-333333333333");
const OTHER_FIELD_ID = toSafeId<"field">(
  "44444444-4444-4444-8444-444444444444",
);

const pinnedReference = (
  workspaceId: typeof OWN_WORKSPACE_ID,
  fileFieldId: typeof OWN_FIELD_ID,
  name: string,
) => ({
  workspaceId,
  workspaceName: `${name} matter`,
  entityId: toSafeId<"entity">("55555555-5555-4555-8555-555555555555"),
  fileFieldId,
  entityVersionId: toSafeId<"entityVersion">(
    "66666666-6666-4666-8666-666666666666",
  ),
  contentSha256: "a".repeat(64),
  name,
});

const BASIS: DocumentReviewRunBasis = {
  type: "references",
  perspective: NEUTRAL_PERSPECTIVE,
  references: [
    pinnedReference(OWN_WORKSPACE_ID, OWN_FIELD_ID, "Own precedent"),
    pinnedReference(OTHER_WORKSPACE_ID, OTHER_FIELD_ID, "Other precedent"),
  ],
};

const PAYLOAD: DocumentReviewFindingPayload = {
  checkKind: "reference",
  finding: {
    findingId: "finding-1",
    topicId: "topic-1",
    issue: "Liability cap",
    assessment: "different",
    consensus: "single",
    explanation: { type: "comparison", text: "Different cap." },
    recommendation: null,
    impact: "unfavourable",
    severity: "high",
    targetCitations: [{ blockId: "target-1", text: "Draft wording." }],
    referenceCitations: [
      {
        fileFieldId: OWN_FIELD_ID,
        citations: [{ blockId: "own-1", text: "Own precedent wording." }],
      },
      {
        fileFieldId: OTHER_FIELD_ID,
        citations: [{ blockId: "other-1", text: "Other precedent wording." }],
      },
    ],
    fix: null,
  },
};

describe("document review reference access", () => {
  test("lists the matters a basis pinned references from", () => {
    expect(basisReferenceWorkspaceIds(BASIS)).toEqual([
      OWN_WORKSPACE_ID,
      OTHER_WORKSPACE_ID,
    ]);
  });

  test("keeps reference text whose matter the reader can access", () => {
    const scope = createReferenceScope({
      basis: BASIS,
      accessibleWorkspaceIds: new Set([OWN_WORKSPACE_ID, OTHER_WORKSPACE_ID]),
    });
    expect(scope(PAYLOAD)).toBe(PAYLOAD);
  });

  test("drops reference text whose matter the reader cannot access", () => {
    const scope = createReferenceScope({
      basis: BASIS,
      accessibleWorkspaceIds: new Set([OWN_WORKSPACE_ID]),
    });
    const scoped = scope(PAYLOAD);
    expect(scoped.checkKind).toBe("reference");
    if (scoped.checkKind !== "reference") {
      return;
    }
    expect(scoped.finding.referenceCitations).toEqual([
      {
        fileFieldId: OWN_FIELD_ID,
        citations: [{ blockId: "own-1", text: "Own precedent wording." }],
      },
    ]);
    expect(scoped.finding.targetCitations).toEqual(
      PAYLOAD.finding.targetCitations,
    );
  });

  test("leaves the precedent position empty when no reference is readable", () => {
    const scope = createReferenceScope({
      basis: BASIS,
      accessibleWorkspaceIds: new Set<string>(),
    });
    const rows = buildIssuesTableRows({
      basis: BASIS,
      findings: [
        {
          topicTitle: "Liability cap",
          payload: scope(PAYLOAD),
          decision: "open",
        },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.precedentPosition).toBe("");
    expect(rows[0]?.draftPosition).toBe("Draft wording.");
  });

  test("passes a playbook payload through unchanged", () => {
    const playbookPayload: DocumentReviewFindingPayload = {
      checkKind: "playbook",
      finding: {
        positionId: "position-1",
        issue: "Liability cap",
        severity: "medium",
        verdict: "deviation",
        rationale: "Below the fallback.",
        extracted: null,
        citations: [],
        fix: null,
      },
    };
    const scope = createReferenceScope({
      basis: BASIS,
      accessibleWorkspaceIds: new Set<string>(),
    });
    expect(scope(playbookPayload)).toBe(playbookPayload);
  });
});
