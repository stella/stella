import { describe, expect, test } from "bun:test";

import type {
  PlaybookFinding,
  ReferenceFinding,
  ReviewTopic,
} from "@/components/ai-suggestions/playbook-review-store";
import {
  buildReviewResultItems,
  isReviewResultActionable,
} from "@/components/inspector/playbook-review-results.logic";

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

describe("review result composition", () => {
  test("joins playbook and reference assessments into one confirmed topic", () => {
    const results = buildReviewResultItems({
      topics: [playbookTopic],
      playbookFindings: [playbookFinding],
      referenceFindings: [referenceFinding],
    });

    expect(results).toEqual([
      {
        id: playbookTopic.topicId,
        title: "Notice period",
        playbook: playbookFinding,
        reference: referenceFinding,
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
    });

    expect(results.map((result) => result.id)).toEqual([playbookTopic.topicId]);
  });

  test("fails when an engine returns a result outside confirmed topics", () => {
    expect(() =>
      buildReviewResultItems({
        topics: [playbookTopic],
        playbookFindings: [
          { ...playbookFinding, positionId: "unconfirmed-position" },
        ],
        referenceFindings: null,
      }),
    ).toThrow("Review topic");
  });
});
