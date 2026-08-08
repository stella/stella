import { describe, expect, test } from "bun:test";

import { mergeProposedReviewTopics } from "@/api/handlers/document-reviews/review-topics";

const seededTopic = {
  type: "playbook" as const,
  topicId: "11111111-1111-4111-8111-111111111111",
  positionId: "11111111-1111-4111-8111-111111111111",
  title: "Payment timing",
  context: "Check the payment window.",
  included: true,
};

describe("reference review topic proposal", () => {
  test("preserves seeded topics and removes normalized proposal duplicates", () => {
    const merged = mergeProposedReviewTopics(
      [seededTopic],
      [
        { title: " payment timing ", context: "Duplicate" },
        { title: "Notice mechanics", context: "Compare delivery methods." },
        { title: "NOTICE MECHANICS", context: "Duplicate casing" },
      ],
    );

    expect(merged.at(0)).toEqual(seededTopic);
    expect(merged.map((topic) => topic.title)).toEqual([
      "Payment timing",
      "Notice mechanics",
    ]);
    expect(merged.at(1)?.type).toBe("reference");
  });
});
