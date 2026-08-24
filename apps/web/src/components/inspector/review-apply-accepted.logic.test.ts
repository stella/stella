import { describe, expect, test } from "bun:test";

import type { ReferenceFile } from "@/components/ai-suggestions/document-review-basis.logic";
import type { ReviewFindingDecisionRow } from "@/components/ai-suggestions/document-review-run.logic";
import type {
  PlaybookFinding,
  ReferenceFinding,
} from "@/components/ai-suggestions/playbook-review-store";
import type { ReviewResultItem } from "@/components/inspector/playbook-review-results.logic";
import {
  buildAcceptedFixBatch,
  buildPrecedentComment,
  collectAcceptedFixes,
} from "@/components/inspector/review-apply-accepted.logic";
import { toSafeId } from "@/lib/safe-id";

const TOPIC_ID = "11111111-1111-4111-8111-111111111111";
const PRECEDENT_FIELD = toSafeId<"field">(
  "22222222-2222-4222-8222-222222222222",
);

const precedent: ReferenceFile = {
  workspaceId: "33333333-3333-4333-8333-333333333333",
  workspaceName: null,
  entityId: "44444444-4444-4444-8444-444444444444",
  fileFieldId: PRECEDENT_FIELD,
  name: "Precedent SPA",
  fileName: "Precedent SPA.docx",
};

const referenceFinding: ReferenceFinding = {
  findingId: "finding-leakage",
  topicId: TOPIC_ID,
  issue: "Leakage",
  assessment: "different",
  consensus: "single",
  explanation: { type: "comparison", text: "The draft caps leakage." },
  recommendation: "Remove the cap.",
  impact: "unfavourable",
  severity: "high",
  targetCitations: [{ blockId: "p-1", text: "Leakage is capped." }],
  referenceCitations: [
    {
      fileFieldId: PRECEDENT_FIELD,
      citations: [
        { blockId: "p-9", text: "Leakage is uncapped." },
        { blockId: "p-10", text: "A second passage." },
      ],
    },
  ],
  fix: { kind: "replaceBlock", blockId: "p-1", text: "No cap applies." },
};

const playbookFinding: PlaybookFinding = {
  positionId: "position-leakage",
  issue: "Leakage",
  severity: "high",
  verdict: "deviation",
  extracted: null,
  rationale: "Shorter than the preferred position.",
  citations: [],
  fix: { kind: "insertAfterBlock", blockId: "p-2", text: "Added wording." },
};

const decision = (value: ReviewFindingDecisionRow["decision"]) => ({
  id: toSafeId<"documentReviewFinding">("0198f2c4-6a55-7c31-9a10-3b1d2f4c5e70"),
  topicId: TOPIC_ID,
  decision: value,
});

const item = (overrides: Partial<ReviewResultItem> = {}): ReviewResultItem => ({
  id: TOPIC_ID,
  title: "Leakage",
  playbook: null,
  reference: referenceFinding,
  decisions: [decision("accepted")],
  ...overrides,
});

describe("buildPrecedentComment", () => {
  test("cites the recommendation and one passage per named reference", () => {
    expect(buildPrecedentComment(referenceFinding, [precedent])).toBe(
      "Remove the cap.\n\nPrecedent (Precedent SPA): “Leakage is uncapped.”",
    );
  });

  test("is null when there is nothing to cite", () => {
    expect(
      buildPrecedentComment(
        { ...referenceFinding, recommendation: null, referenceCitations: [] },
        [precedent],
      ),
    ).toBeNull();
  });
});

describe("collectAcceptedFixes", () => {
  test("takes accepted findings whose fix is not in the document yet", () => {
    const plans = collectAcceptedFixes({
      items: [
        item(),
        item({ id: "open", decisions: [decision("open")] }),
        item({ id: "dismissed", decisions: [decision("dismissed")] }),
        item({
          id: "applied",
          reference: { ...referenceFinding, findingId: "finding-applied" },
        }),
        item({ id: "no-fix", reference: { ...referenceFinding, fix: null } }),
      ],
      fixStateByFinding: {
        "finding-applied": { status: "applied", revisionIds: [4] },
      },
      references: [precedent],
      playbookName: "Buy-side SPA",
    });
    expect(plans.map((plan) => plan.findingKey)).toEqual(["finding-leakage"]);
  });

  test("yields both fixes for a topic judged by playbook and precedent", () => {
    const plans = collectAcceptedFixes({
      items: [item({ playbook: playbookFinding })],
      fixStateByFinding: {},
      references: [precedent],
      playbookName: "Buy-side SPA",
    });
    expect(plans.map((plan) => [plan.findingKey, plan.comment])).toEqual([
      [
        "position-leakage",
        "Playbook (Buy-side SPA): Shorter than the preferred position.",
      ],
      [
        "finding-leakage",
        "Remove the cap.\n\nPrecedent (Precedent SPA): “Leakage is uncapped.”",
      ],
    ]);
  });
});

describe("buildAcceptedFixBatch", () => {
  test("pairs each fix with its comment on the same block", () => {
    let counter = 0;
    const plans = collectAcceptedFixes({
      items: [item()],
      fixStateByFinding: {},
      references: [precedent],
      playbookName: "",
    });
    const batch = buildAcceptedFixBatch({
      plans,
      newId: () => String((counter += 1)),
    });
    expect(batch.fixOperationIdByKey.get("finding-leakage")).toBe("pb-fix-1");
    expect(batch.operations).toEqual([
      {
        id: "pb-fix-1",
        type: "replaceBlock",
        blockId: "p-1",
        text: "No cap applies.",
      },
      {
        id: "review-comment-2",
        type: "commentOnBlock",
        blockId: "p-1",
        comment: {
          text: "Remove the cap.\n\nPrecedent (Precedent SPA): “Leakage is uncapped.”",
        },
      },
    ]);
  });
});
