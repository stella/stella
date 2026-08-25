import { describe, expect, test } from "bun:test";

import type { DocumentReviewFindingRow } from "@/components/ai-suggestions/document-review-queries";
import type { ReviewFindingDecisionRow } from "@/components/ai-suggestions/document-review-run.logic";
import type {
  PlaybookFinding,
  ReferenceFinding,
  ReviewTopic,
} from "@/components/ai-suggestions/playbook-review-store";
import {
  buildReviewResultItems,
  isReviewResultActionable,
  isReviewResultActionNeeded,
  reviewItemDecision,
} from "@/components/inspector/playbook-review-results.logic";
import { toSafeId } from "@/lib/safe-id";

/** The playbook finding exactly as a run persists it, taken from the run read
 *  rather than restated. `PlaybookFinding` is hand-written, so this is what
 *  binds the two together. */
type PersistedPlaybookFinding = Extract<
  DocumentReviewFindingRow["payload"],
  { checkKind: "playbook" }
>["finding"];

const playbookTopic: ReviewTopic = {
  type: "playbook",
  topicId: "11111111-1111-4111-8111-111111111111",
  positionId: "11111111-1111-4111-8111-111111111111",
  title: "Notice period",
  context: "",
  included: true,
};

const playbookFinding: PlaybookFinding = {
  positionId: playbookTopic.positionId,
  issue: "Notice period",
  severity: "high",
  verdict: "deviation",
  extracted: null,
  rationale: "The period is shorter than the preferred position.",
  citations: [],
  fix: null,
};

const referenceFinding: ReferenceFinding = {
  findingId: `reference-${playbookTopic.topicId}`,
  topicId: playbookTopic.topicId,
  issue: "Notice period",
  assessment: "different",
  consensus: "single",
  explanation: {
    type: "comparison",
    text: "The reference uses a longer period.",
  },
  targetCitations: [],
  referenceCitations: [],
  fix: null,
};

const playbookRow: ReviewFindingDecisionRow = {
  id: toSafeId<"documentReviewFinding">("0198f2c4-6a55-7c31-9a10-3b1d2f4c5e70"),
  topicId: playbookTopic.topicId,
  checkKind: "playbook",
  decision: "open",
  applicationStatus: "pending",
};

const referenceRow: ReviewFindingDecisionRow = {
  id: toSafeId<"documentReviewFinding">("0198f2c4-6a55-7c31-9a10-3b1d2f4c5e71"),
  topicId: playbookTopic.topicId,
  checkKind: "reference",
  decision: "open",
  applicationStatus: "pending",
};

describe("review result composition", () => {
  test("joins playbook and reference assessments into one confirmed topic", () => {
    const results = buildReviewResultItems({
      topics: [playbookTopic],
      playbookFindings: [playbookFinding],
      referenceFindings: [referenceFinding],
      decisions: [playbookRow, referenceRow],
    });

    expect(results).toEqual([
      {
        id: playbookTopic.topicId,
        title: "Notice period",
        playbook: playbookFinding,
        reference: referenceFinding,
        decisions: [playbookRow, referenceRow],
      },
    ]);
    expect(results.every(isReviewResultActionable)).toBe(true);
  });

  test("preserves confirmed topic order and omits excluded topics", () => {
    const referenceTopic: ReviewTopic = {
      type: "reference",
      topicId: "22222222-2222-4222-8222-222222222222",
      title: "Payment timing",
      context: "",
      included: false,
    };

    const results = buildReviewResultItems({
      topics: [referenceTopic, playbookTopic],
      playbookFindings: [playbookFinding],
      referenceFindings: [referenceFinding],
      decisions: [playbookRow, referenceRow],
    });

    expect(results.map((result) => result.id)).toEqual([playbookTopic.topicId]);
  });

  test("renders a finding persisted by the files-table run path", () => {
    // What the table path writes: a graded verdict with its rationale and the
    // extracted value, and no citations — the workflow's batch extraction does
    // not verify folio anchors, so there is nothing to cite and nothing to
    // ground a fix on. Pinned with `satisfies` against the persisted payload,
    // so a producer-side shape change fails here instead of rendering as
    // `undefined` in the results list.
    const persisted = {
      positionId: playbookTopic.positionId,
      issue: "Notice period",
      severity: "high",
      verdict: "deviation",
      extracted: { value: "14 days", text: "14 days" },
      rationale: "The period is shorter than the preferred position.",
      citations: [],
      fix: null,
    } satisfies PersistedPlaybookFinding;

    const results = buildReviewResultItems({
      topics: [playbookTopic],
      playbookFindings: [persisted],
      referenceFindings: null,
      decisions: [playbookRow],
    });

    expect(results).toEqual([
      {
        id: playbookTopic.topicId,
        title: "Notice period",
        playbook: persisted,
        reference: null,
        decisions: [playbookRow],
      },
    ]);
    expect(results.every(isReviewResultActionable)).toBe(true);
  });

  test("fails when an engine returns a result outside confirmed topics", () => {
    expect(() =>
      buildReviewResultItems({
        topics: [playbookTopic],
        playbookFindings: [
          { ...playbookFinding, positionId: "unconfirmed-position" },
        ],
        referenceFindings: null,
        decisions: [playbookRow],
      }),
    ).toThrow("Review topic");
  });
});

const decidedItem = (
  playbookDecision: ReviewFindingDecisionRow["decision"],
  referenceDecision: ReviewFindingDecisionRow["decision"],
) => {
  const item = buildReviewResultItems({
    topics: [playbookTopic],
    playbookFindings: [playbookFinding],
    referenceFindings: [referenceFinding],
    decisions: [
      { ...playbookRow, decision: playbookDecision },
      { ...referenceRow, decision: referenceDecision },
    ],
  }).at(0);
  if (item === undefined) {
    throw new Error("The confirmed topic produced no result item");
  }
  return item;
};

describe("what still needs the reviewer", () => {
  test("a flagged finding nobody has answered needs action", () => {
    const item = decidedItem("open", "open");

    expect(reviewItemDecision(item)).toBe("open");
    expect(isReviewResultActionNeeded(item)).toBe(true);
  });

  test("accepting or dismissing takes the finding off the list", () => {
    for (const decision of ["accepted", "dismissed"] as const) {
      const item = decidedItem(decision, decision);

      expect(reviewItemDecision(item)).toBe(decision);
      // The finding is unchanged; only the reviewer's answer to it moved.
      expect(isReviewResultActionable(item)).toBe(true);
      expect(isReviewResultActionNeeded(item)).toBe(false);
    }
  });

  test("a card whose checks were decided differently still needs the reviewer", () => {
    const mixed = decidedItem("accepted", "dismissed");
    const partly = decidedItem("accepted", "open");

    expect(reviewItemDecision(mixed)).toBe("open");
    expect(isReviewResultActionNeeded(mixed)).toBe(true);
    expect(reviewItemDecision(partly)).toBe("open");
    expect(isReviewResultActionNeeded(partly)).toBe(true);
  });

  test("a finding that was never flagged needs no action, decided or not", () => {
    const aligned = buildReviewResultItems({
      topics: [playbookTopic],
      playbookFindings: [{ ...playbookFinding, verdict: "compliant" }],
      referenceFindings: [{ ...referenceFinding, assessment: "aligned" }],
      decisions: [playbookRow, referenceRow],
    });

    expect(aligned.filter(isReviewResultActionable)).toEqual([]);
    expect(aligned.filter(isReviewResultActionNeeded)).toEqual([]);
  });
});
